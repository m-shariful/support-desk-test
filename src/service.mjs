import {
  DeskError,
  inTransaction,
  openStore,
  record,
  ticketView,
} from "./store.mjs";

import { randomUUID } from "node:crypto";

/**
 * Business logic for the support desk.
 *
 * Responsibilities:
 * - Enforce tenant-scoped ticket access.
 * - Process inbound webhook events idempotently.
 * - Track draft versions and human approvals.
 * - Persist delivery attempts before contacting the provider.
 * - Treat uncertain delivery outcomes conservatively.
 */
export class DeskService {
  constructor({ databasePath = ":memory:", provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }

  close() {
    this.db.close();
  }

  /**
   * Return only the tickets belonging to the authenticated organization.
   */
  listTickets(actor) {
    return this.db
      .prepare(
        `
      SELECT *
      FROM tickets
      WHERE tenant_id = ?
      ORDER BY id
    `,
      )
      .all(actor.tenantId);
  }

  /**
   * Centralized authorization boundary for ticket operations.
   *
   * Always include tenant_id in the database query.
   * A globally unique ticket ID is not an authorization check.
   */
  row(actor, id) {
    const row = this.db
      .prepare(
        `
      SELECT *
      FROM tickets
      WHERE id = ?
        AND tenant_id = ?
    `,
      )
      .get(id, actor.tenantId);

    if (!row) {
      // Returning 404 also avoids revealing another tenant's ticket exists.
      throw new DeskError(404, "Ticket not found");
    }

    return row;
  }

  getTicket(actor, id) {
    return ticketView(this.db, this.row(actor, id));
  }

  /**
   * Process an inbound webhook exactly once per tenant + event ID.
   *
   * The event ledger, message, and audit record are written in one
   * transaction. A duplicate event cannot create a second message.
   */
  receiveWebhook(event) {
    if (
      !event ||
      typeof event.tenantId !== "string" ||
      !event.tenantId.trim() ||
      !Number.isInteger(Number(event.ticketId)) ||
      typeof event.eventId !== "string" ||
      !event.eventId.trim() ||
      typeof event.body !== "string" ||
      !event.body.trim()
    ) {
      throw new DeskError(400, "Invalid event");
    }

    const tenantId = event.tenantId.trim();
    const eventId = event.eventId.trim();
    const ticketId = Number(event.ticketId);

    return inTransaction(this.db, () => {
      // The webhook may only reference a ticket in its declared tenant.
      const ticket = this.db
        .prepare(
          `
        SELECT *
        FROM tickets
        WHERE id = ?
          AND tenant_id = ?
      `,
        )
        .get(ticketId, tenantId);

      if (!ticket) {
        throw new DeskError(400, "Invalid event");
      }

      /*
       * The UNIQUE(tenant_id, event_id) database constraint is the
       * final protection against duplicate and concurrent webhook calls.
       */
      const inserted = this.db
        .prepare(
          `
        INSERT OR IGNORE INTO webhook_events
          (tenant_id, event_id, ticket_id)
        VALUES (?, ?, ?)
      `,
        )
        .run(tenantId, eventId, ticket.id);

      if (inserted.changes === 0) {
        return {
          accepted: true,
          duplicate: true,
        };
      }

      this.db
        .prepare(
          `
        INSERT INTO messages(ticket_id, event_id, body)
        VALUES (?, ?, ?)
      `,
        )
        .run(ticket.id, eventId, event.body);

      record(this.db, ticket.id, "inbound", eventId);

      return {
        accepted: true,
        duplicate: false,
      };
    });
  }

  /**
   * Save a new draft version.
   *
   * Any edit invalidates approval of the previous version.
   * Do not allow edits while delivery is still unresolved.
   */
  updateDraft(actor, id, body) {
    const ticket = this.row(actor, id);

    if (typeof body !== "string" || !body.trim()) {
      throw new DeskError(400, "A reply is required");
    }

    if (ticket.send_state === "SENDING" || ticket.send_state === "UNKNOWN") {
      throw new DeskError(
        409,
        "Resolve the existing delivery attempt before editing this reply",
      );
    }

    inTransaction(this.db, () => {
      this.db
        .prepare(
          `
        UPDATE tickets
        SET draft = ?,
            version = version + 1,
            approved_version = NULL,
            send_state = 'DRAFT'
        WHERE id = ?
          AND tenant_id = ?
      `,
        )
        .run(body, id, actor.tenantId);

      record(this.db, id, "draft_updated", actor.id);
    });

    return this.getTicket(actor, id);
  }

  /**
   * Explicitly approve the current saved draft version.
   */
  approveDraft(actor, id) {
    const ticket = this.row(actor, id);

    if (!ticket.draft || !ticket.draft.trim()) {
      throw new DeskError(400, "No draft");
    }

    if (ticket.send_state === "SENDING" || ticket.send_state === "UNKNOWN") {
      throw new DeskError(
        409,
        "Resolve the existing delivery attempt before approving another reply",
      );
    }

    inTransaction(this.db, () => {
      this.db
        .prepare(
          `
        UPDATE tickets
        SET approved_version = version
        WHERE id = ?
          AND tenant_id = ?
      `,
        )
        .run(id, actor.tenantId);

      record(
        this.db,
        id,
        "approved",
        `version ${ticket.version} by ${actor.id}`,
      );
    });

    return this.getTicket(actor, id);
  }

  /**
   * Transfer ownership to a human operator.
   *
   * Future automatic dispatches must check this ownership state.
   */
  handoff(actor, id) {
    this.row(actor, id);

    inTransaction(this.db, () => {
      this.db
        .prepare(
          `
        UPDATE tickets
        SET owner = 'human'
        WHERE id = ?
          AND tenant_id = ?
      `,
        )
        .run(id, actor.tenantId);

      record(this.db, id, "human_handoff", actor.id);
    });

    return this.getTicket(actor, id);
  }

  /**
   * Send the currently approved reply.
   *
   * Critical safety rule:
   * The attempt is committed to SQLite before the provider is called.
   * This prevents overlapping requests from dispatching the same version.
   */
  async sendReply(actor, id, { automatic = false } = {}) {
    const ticket = this.row(actor, id);

    if (automatic && ticket.owner === "human") {
      throw new DeskError(409, "Human has taken over; automation is disabled");
    }

    if (!ticket.draft || !ticket.draft.trim()) {
      throw new DeskError(409, "Save a reply first");
    }

    // Approval must refer to the exact current draft version.
    if (
      ticket.approved_version == null ||
      ticket.approved_version !== ticket.version
    ) {
      throw new DeskError(409, "Approve the current reply version first");
    }

    if (ticket.send_state === "SENDING" || ticket.send_state === "UNKNOWN") {
      throw new DeskError(
        409,
        "Delivery is unresolved; reconcile before taking another action",
      );
    }

    // Never dispatch a version that already has an attempt.
    const existing = this.db
      .prepare(
        `
      SELECT *
      FROM attempts
      WHERE ticket_id = ?
        AND version = ?
    `,
      )
      .get(id, ticket.version);

    if (existing) {
      throw new DeskError(
        409,
        `This reply version already has a delivery attempt (${existing.state})`,
      );
    }

    const clientRef = randomUUID();

    /*
     * Persist the attempt before making the external request.
     *
     * This transaction is synchronous. No network request is awaited
     * while the SQLite transaction is open.
     */
    try {
      inTransaction(this.db, () => {
        this.db
          .prepare(
            `
          INSERT INTO attempts
            (ticket_id, version, client_ref, body, state)
          VALUES (?, ?, ?, ?, 'SENDING')
        `,
          )
          .run(id, ticket.version, clientRef, ticket.draft);

        this.db
          .prepare(
            `
          UPDATE tickets
          SET send_state = 'SENDING'
          WHERE id = ?
            AND tenant_id = ?
        `,
          )
          .run(id, actor.tenantId);

        record(
          this.db,
          id,
          "send_started",
          `${automatic ? "automation" : actor.id}: ${clientRef}`,
        );
      });
    } catch (error) {
      // The unique constraint is the final concurrency guard.
      if (String(error.message).includes("UNIQUE")) {
        throw new DeskError(
          409,
          "A send attempt already exists for this reply version",
        );
      }

      throw error;
    }

    try {
      const result = await this.provider.send({
        clientRef,
        ticketId: id,
        body: ticket.draft,
      });

      if (!result?.providerMessageId) {
        throw new Error("Provider response did not confirm a message ID");
      }

      // Provider explicitly confirmed acceptance.
      inTransaction(this.db, () => {
        this.db
          .prepare(
            `
          UPDATE attempts
          SET state = 'SENT',
              provider_id = ?
          WHERE client_ref = ?
        `,
          )
          .run(result.providerMessageId, clientRef);

        this.db
          .prepare(
            `
          UPDATE tickets
          SET send_state = 'SENT'
          WHERE id = ?
            AND tenant_id = ?
        `,
          )
          .run(id, actor.tenantId);

        record(
          this.db,
          id,
          "sent",
          `${automatic ? "automation" : actor.id}: ${result.providerMessageId}`,
        );
      });
    } catch (error) {
      /*
       * The mock provider defines kind='not_accepted' for HTTP 503.
       * That is a definite rejection.
       *
       * A timeout, connection loss, HTTP 504, or unexpected response
       * is uncertain. The provider may already have accepted the message.
       */
      const definitelyRejected = error.kind === "not_accepted";
      const state = definitelyRejected ? "REJECTED" : "UNKNOWN";

      inTransaction(this.db, () => {
        this.db
          .prepare(
            `
          UPDATE attempts
          SET state = ?
          WHERE client_ref = ?
        `,
          )
          .run(state, clientRef);

        this.db
          .prepare(
            `
          UPDATE tickets
          SET send_state = ?
          WHERE id = ?
            AND tenant_id = ?
        `,
          )
          .run(state, id, actor.tenantId);

        record(
          this.db,
          id,
          definitelyRejected ? "send_rejected" : "send_unknown",
          `${clientRef}: ${error.message}`,
        );
      });

      if (!definitelyRejected) {
        // Never retry an uncertain delivery automatically.
        return this.getTicket(actor, id);
      }
    }

    return this.getTicket(actor, id);
  }

  /**
   * Resolve an UNKNOWN or interrupted SENDING attempt using provider evidence.
   *
   * A provider lookup returning not_found is inconclusive under the
   * assessment contract. It must not authorize another send.
   */
  async reconcile(actor, id) {
    this.row(actor, id);

    const attempt = this.db
      .prepare(
        `
      SELECT *
      FROM attempts
      WHERE ticket_id = ?
        AND state IN ('UNKNOWN', 'SENDING')
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(id);

    if (!attempt) {
      throw new DeskError(
        409,
        "There is no uncertain delivery attempt to reconcile",
      );
    }

    let evidence;

    try {
      evidence = await this.provider.lookup(attempt.client_ref);
    } catch {
      throw new DeskError(
        502,
        "Provider lookup failed; delivery remains UNKNOWN",
      );
    }

    if (evidence?.state === "delivered" && evidence.providerMessageId) {
      inTransaction(this.db, () => {
        this.db
          .prepare(
            `
          UPDATE attempts
          SET state = 'SENT',
              provider_id = ?
          WHERE id = ?
        `,
          )
          .run(evidence.providerMessageId, attempt.id);

        this.db
          .prepare(
            `
          UPDATE tickets
          SET send_state = 'SENT'
          WHERE id = ?
        `,
          )
          .run(id);

        record(
          this.db,
          id,
          "delivery_reconciled",
          `${attempt.client_ref}: ${evidence.providerMessageId}`,
        );
      });
    } else {
      // not_found is not proof that the provider never accepted the send.
      inTransaction(this.db, () => {
        this.db
          .prepare(
            `
          UPDATE attempts
          SET state = 'UNKNOWN'
          WHERE id = ?
        `,
          )
          .run(attempt.id);

        this.db
          .prepare(
            `
          UPDATE tickets
          SET send_state = 'UNKNOWN'
          WHERE id = ?
        `,
          )
          .run(id);

        record(this.db, id, "reconciliation_inconclusive", attempt.client_ref);
      });
    }

    return this.getTicket(actor, id);
  }
}
