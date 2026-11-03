import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Application-level error with an HTTP status.
 *
 * The HTTP layer can translate this into a 4xx response without
 * exposing database-specific error details to the client.
 */
export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DeskError";
    this.status = status;
  }
}

/**
 * Open the SQLite database and ensure the required schema exists.
 *
 * The assessment intentionally uses a single local application process
 * and SQLite. WAL and busy_timeout improve behavior when requests overlap.
 */
export function openStore(path) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      contact TEXT NOT NULL,
      subject TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'automation',
      draft TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0,
      approved_version INTEGER,
      send_state TEXT NOT NULL DEFAULT 'DRAFT'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      client_ref TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      provider_id TEXT,

      -- A reply version gets at most one delivery attempt.
      UNIQUE(ticket_id, version)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      ticket_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- The same external event can be accepted only once per tenant.
      UNIQUE(tenant_id, event_id)
    );

    -- Local demonstration fixtures. These are not real customer records.
    INSERT OR IGNORE INTO tickets
      (id, tenant_id, contact, subject)
    VALUES
      (101, 'alpha', 'Jordan Demo', 'Cannot resume my practice exam'),
      (202, 'beta', 'Casey Example', 'Course completion is missing');
  `);

  /*
   * Crash recovery:
   *
   * A process may stop after the provider accepted a message but before
   * our application persisted the provider's response.
   *
   * We cannot safely assume that an interrupted SENDING attempt failed.
   * Therefore, recover it as UNKNOWN and require reconciliation.
   */
  db.exec(`
    BEGIN IMMEDIATE;

    UPDATE attempts
    SET state = 'UNKNOWN'
    WHERE state = 'SENDING';

    UPDATE tickets
    SET send_state = 'UNKNOWN'
    WHERE send_state = 'SENDING'
      AND EXISTS (
        SELECT 1
        FROM attempts AS a
        WHERE a.ticket_id = tickets.id
          AND a.state = 'UNKNOWN'
      );

    COMMIT;
  `);

  return db;
}

/**
 * Execute related database writes atomically.
 *
 * BEGIN IMMEDIATE obtains the SQLite write reservation before running
 * the callback. This matters when multiple requests overlap.
 *
 * The callback must be synchronous: do not await network requests inside
 * a SQLite transaction.
 */
export function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Record an auditable business event.
 *
 * Call this inside the same transaction as the state change it describes.
 */
export function record(db, ticketId, action, detail) {
  db.prepare(
    `
    INSERT INTO audit(ticket_id, action, detail)
    VALUES (?, ?, ?)
  `,
  ).run(ticketId, action, String(detail));
}

/**
 * Build the complete ticket response from its base row and related records.
 */
export function ticketView(db, row) {
  return {
    ...row,

    messages: db
      .prepare(
        `
      SELECT *
      FROM messages
      WHERE ticket_id = ?
      ORDER BY id
    `,
      )
      .all(row.id),

    audit: db
      .prepare(
        `
      SELECT *
      FROM audit
      WHERE ticket_id = ?
      ORDER BY id
    `,
      )
      .all(row.id),

    attempts: db
      .prepare(
        `
      SELECT *
      FROM attempts
      WHERE ticket_id = ?
      ORDER BY id
    `,
      )
      .all(row.id),
  };
}

/**
 * Synthetic demo identities.
 *
 * The server resolves the actor from the Authorization header.
 * Never trust a tenant ID supplied by the browser for authorization.
 */
export const actors = {
  "demo-alpha-token": {
    id: "agent-alpha",
    tenantId: "alpha",
  },

  "demo-beta-token": {
    id: "agent-beta",
    tenantId: "beta",
  },
};
