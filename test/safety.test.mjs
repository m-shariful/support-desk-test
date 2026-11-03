import { mkdtempSync, rmSync } from "node:fs";

import { DeskService } from "../src/service.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";

const alpha = {
  id: "agent-alpha",
  tenantId: "alpha",
};

const beta = {
  id: "agent-beta",
  tenantId: "beta",
};

/**
 * Create an isolated service instance for each test.
 *
 * A separate temporary SQLite database prevents tests from affecting
 * each other's tickets, messages, audit events, or delivery attempts.
 */
function createHarness(t, provider = {}) {
  const directory = mkdtempSync(join(tmpdir(), "justinsurance-test-"));
  const databasePath = join(directory, "test.sqlite");

  const service = new DeskService({
    databasePath,
    provider: {
      send: async () => ({
        providerMessageId: "provider-demo-1",
      }),
      lookup: async () => ({
        state: "not_found",
      }),
      ...provider,
    },
  });

  t.after(() => {
    try {
      service.close();
    } catch {
      // A restart test may already have closed this connection.
    }

    rmSync(directory, {
      recursive: true,
      force: true,
    });
  });

  return {
    service,
    databasePath,
  };
}

/**
 * Prepare a draft and explicitly approve its current version.
 */
function prepareApprovedReply(service, actor = alpha, ticketId = 101) {
  service.updateDraft(actor, ticketId, "A support agent will help you.");
  service.approveDraft(actor, ticketId);
}

/* -------------------------------------------------------
 * 1. Tenant isolation: reading another tenant's ticket
 * ----------------------------------------------------- */

test("tenant isolation: Alpha cannot read Beta ticket", (t) => {
  const { service } = createHarness(t);

  assert.throws(
    () => service.getTicket(alpha, 202),
    (error) => error.status === 404,
  );
});

/* -------------------------------------------------------
 * 2. Tenant isolation: modifying another tenant's ticket
 * ----------------------------------------------------- */

test("tenant isolation: Alpha cannot modify Beta ticket", (t) => {
  const { service } = createHarness(t);

  assert.throws(
    () => service.updateDraft(beta, 101, "Unauthorized change"),
    (error) => error.status === 404,
  );

  assert.equal(service.getTicket(alpha, 101).draft, "");
});

/* -------------------------------------------------------
 * 3. Webhook idempotency
 * ----------------------------------------------------- */

test("webhook replay creates only one message and audit event", (t) => {
  const { service } = createHarness(t);

  const event = {
    tenantId: "alpha",
    ticketId: 101,
    eventId: "event-unique-1",
    body: "I need help with my practice exam.",
  };

  const first = service.receiveWebhook(event);
  const replay = service.receiveWebhook(event);

  const ticket = service.getTicket(alpha, 101);

  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);

  assert.equal(ticket.messages.length, 1);

  assert.equal(
    ticket.audit.filter((item) => item.action === "inbound").length,
    1,
  );
});

/* -------------------------------------------------------
 * 4. Webhook tenant ownership
 * ----------------------------------------------------- */

test("webhook cannot attach an event to another tenant ticket", (t) => {
  const { service } = createHarness(t);

  assert.throws(
    () =>
      service.receiveWebhook({
        tenantId: "alpha",
        ticketId: 202,
        eventId: "cross-tenant-event",
        body: "Unauthorized message",
      }),
    (error) => error.status === 400,
  );

  assert.equal(service.getTicket(beta, 202).messages.length, 0);
});

/* -------------------------------------------------------
 * 5. Editing a draft invalidates previous approval
 * ----------------------------------------------------- */

test("editing a draft invalidates its previous approval", (t) => {
  const { service } = createHarness(t);

  service.updateDraft(alpha, 101, "Original approved reply.");
  service.approveDraft(alpha, 101);

  const approved = service.getTicket(alpha, 101);

  assert.equal(approved.approved_version, approved.version);

  service.updateDraft(alpha, 101, "Updated reply.");

  const updated = service.getTicket(alpha, 101);

  assert.equal(updated.approved_version, null);
  assert.equal(updated.version, approved.version + 1);
});

/* -------------------------------------------------------
 * 6. Sending an outdated approval must be rejected
 * ----------------------------------------------------- */

test("an edited but unapproved reply cannot be sent", async (t) => {
  const { service } = createHarness(t);

  let providerCalls = 0;

  // Replace the default provider with an observable provider.
  service.provider.send = async () => {
    providerCalls++;

    return {
      providerMessageId: "should-not-be-called",
    };
  };

  service.updateDraft(alpha, 101, "Original reply.");
  service.approveDraft(alpha, 101);

  service.updateDraft(alpha, 101, "Changed reply.");

  await assert.rejects(
    service.sendReply(alpha, 101),
    (error) => error.status === 409,
  );

  assert.equal(providerCalls, 0);
});

/* -------------------------------------------------------
 * 7. Human takeover must stop automation
 * ----------------------------------------------------- */

test("automation cannot send after human takeover", async (t) => {
  const { service } = createHarness(t);

  let providerCalls = 0;

  service.provider.send = async () => {
    providerCalls++;

    return {
      providerMessageId: "unexpected-automation-send",
    };
  };

  prepareApprovedReply(service);

  service.handoff(alpha, 101);

  await assert.rejects(
    service.sendReply(alpha, 101, {
      automatic: true,
    }),
    (error) => error.status === 409,
  );

  assert.equal(providerCalls, 0);
});

/* -------------------------------------------------------
 * 8. Human operators can still send approved replies
 * ----------------------------------------------------- */

test("human operator can send an approved reply after takeover", async (t) => {
  const { service } = createHarness(t);

  prepareApprovedReply(service);

  service.handoff(alpha, 101);

  // Manual dispatch is allowed; automation is not.
  const ticket = await service.sendReply(alpha, 101);

  assert.equal(ticket.owner, "human");
  assert.equal(ticket.send_state, "SENT");
  assert.equal(ticket.attempts.length, 1);
});

/* -------------------------------------------------------
 * 9. Persist attempt before contacting provider
 * ----------------------------------------------------- */

test("delivery attempt is persisted before provider dispatch", async (t) => {
  const { service } = createHarness(t);

  prepareApprovedReply(service);

  let attemptVisibleToProvider = false;

  service.provider.send = async ({ clientRef }) => {
    const attempt = service.db
      .prepare(
        `
      SELECT *
      FROM attempts
      WHERE client_ref = ?
    `,
      )
      .get(clientRef);

    attemptVisibleToProvider = Boolean(attempt && attempt.state === "SENDING");

    return {
      providerMessageId: "provider-persisted-first",
    };
  };

  await service.sendReply(alpha, 101);

  assert.equal(attemptVisibleToProvider, true);
});

/* -------------------------------------------------------
 * 10. Unknown delivery must never be automatically retried
 * ----------------------------------------------------- */

test("timeout produces UNKNOWN and a second send is rejected", async (t) => {
  const { service } = createHarness(t);

  let providerCalls = 0;

  service.provider.send = async () => {
    providerCalls++;

    // Simulate a network timeout after a possible provider acceptance.
    throw new Error("Connection timed out");
  };

  prepareApprovedReply(service);

  const ticket = await service.sendReply(alpha, 101);

  assert.equal(ticket.send_state, "UNKNOWN");
  assert.equal(ticket.attempts.length, 1);
  assert.equal(ticket.attempts[0].state, "UNKNOWN");

  await assert.rejects(
    service.sendReply(alpha, 101),
    (error) => error.status === 409,
  );

  // The second call must not dispatch another provider request.
  assert.equal(providerCalls, 1);
});

/* -------------------------------------------------------
 * 11. Reconciliation must resolve the existing attempt
 * ----------------------------------------------------- */

test("provider-confirmed delivery reconciles the existing attempt", async (t) => {
  const { service } = createHarness(t);

  service.provider.send = async () => {
    throw new Error("Connection timed out");
  };

  service.provider.lookup = async () => ({
    state: "delivered",
    providerMessageId: "provider-confirmed-123",
  });

  prepareApprovedReply(service);

  const uncertain = await service.sendReply(alpha, 101);
  const originalAttemptId = uncertain.attempts[0].id;

  const reconciled = await service.reconcile(alpha, 101);

  assert.equal(reconciled.send_state, "SENT");
  assert.equal(reconciled.attempts.length, 1);

  assert.equal(reconciled.attempts[0].id, originalAttemptId);

  assert.equal(reconciled.attempts[0].provider_id, "provider-confirmed-123");
});

/* -------------------------------------------------------
 * 12. Restart recovery and inconclusive reconciliation
 * ----------------------------------------------------- */

test("interrupted send recovers as UNKNOWN and not_found stays UNKNOWN", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "justinsurance-restart-"));
  const databasePath = join(directory, "restart.sqlite");

  let firstService;

  try {
    let providerStarted;

    const started = new Promise((resolve) => {
      providerStarted = resolve;
    });

    firstService = new DeskService({
      databasePath,

      provider: {
        send: async () => {
          // Signal that dispatch has started, but never resolve it.
          // This simulates an application interruption during a send.
          providerStarted();

          return new Promise(() => {});
        },

        lookup: async () => ({
          state: "not_found",
        }),
      },
    });

    prepareApprovedReply(firstService);

    // Do not await this: the simulated provider request never resolves.
    firstService.sendReply(alpha, 101);

    await started;

    const attemptsBeforeRestart = firstService.getTicket(alpha, 101).attempts;

    assert.equal(attemptsBeforeRestart.length, 1);
    assert.equal(attemptsBeforeRestart[0].state, "SENDING");

    // Simulate the application process closing.
    firstService.close();
    firstService = null;

    // Opening the same persistent database runs startup recovery.
    const restartedService = new DeskService({
      databasePath,

      provider: {
        send: async () => {
          throw new Error("A retry must not happen");
        },

        lookup: async () => ({
          state: "not_found",
        }),
      },
    });

    try {
      const recovered = restartedService.getTicket(alpha, 101);

      assert.equal(recovered.send_state, "UNKNOWN");
      assert.equal(recovered.attempts.length, 1);
      assert.equal(recovered.attempts[0].state, "UNKNOWN");

      // not_found is inconclusive; it does not authorize a resend.
      const reconciled = await restartedService.reconcile(alpha, 101);

      assert.equal(reconciled.send_state, "UNKNOWN");
      assert.equal(reconciled.attempts.length, 1);
      assert.equal(reconciled.attempts[0].state, "UNKNOWN");
    } finally {
      restartedService.close();
    }
  } finally {
    if (firstService) {
      firstService.close();
    }

    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
