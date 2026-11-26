// Puts the domain modules together. HTTP, Telegram and MCP are thin adapters over what this returns.
import { createAccounts } from "./accounts.mjs";
import { createAdmin } from "./admin.mjs";
import { createAssistant } from "./assistant.mjs";
import { createAvailability } from "./availability.mjs";
import { createBookings } from "./bookings.mjs";
import { createCatalog } from "./catalog.mjs";
import { createInsights } from "./insights.mjs";
import { createMetrics } from "./metrics.mjs";
import { createPartners } from "./partners.mjs";
import { createPlans } from "./plans.mjs";
import { createStage } from "./stage.mjs";
import { createWaitlist } from "./waitlist.mjs";
import { createTrips } from "./trips.mjs";
import { createPayments } from "../payments/payments.mjs";

/** Listeners hear about a change only after PostgreSQL has saved it. A failing listener never breaks the change. */
export function createEvents(db) {
  const listeners = new Map();
  return {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) db.afterCommit(() => fn(payload)); },
  };
}

export function createDomain({ db, config, fetchFn = fetch }) {
  const events = createEvents(db);
  const audit = (actor, action, target) => db.run("INSERT INTO audit_log (actor,action,target) VALUES (?,?,?)", actor, action, target);
  // Bookings ask for refunds and payments deliver bookings, so one of the two is connected late.
  let payments;
  const refunds = { summary: (...a) => payments.summary(...a), refundBooking: (...a) => payments.refundBooking(...a) };

  const accounts = createAccounts({ db, audit, site: config });
  const plans = createPlans({ db, accounts });
  const catalog = createCatalog({ db, accounts, plans, events });
  const availability = createAvailability({ db, catalog, events });
  const bookings = createBookings({ db, events, accounts, catalog, availability, plans, refunds });
  payments = createPayments({ db, config, fetchFn, accounts, bookings, plans, audit });
  const trips = createTrips({ db, catalog, availability, bookings });
  const waitlist = createWaitlist({ db, catalog, availability });
  const insights = createInsights({ db, accounts, availability, plans });
  const partners = createPartners({ db, audit }), stage = createStage({ db, accounts });
  const metrics = createMetrics({ db, config, partners });
  const admin = createAdmin({ db, accounts, payments, audit, events, config });

  const core = {};
  for (const part of [accounts, plans, catalog, availability, bookings, trips, insights, waitlist]) for (const [k, fn] of Object.entries(part)) {
    if (k in core) throw new Error(`Two domain functions are named ${k}`);
    core[k] = typeof fn === "function" ? fn.bind(part) : fn;
  }
  core.search = (p) => catalog.search(p, availability.slotsMany);
  core.nextTimes = (ids, p) => catalog.nextTimes(ids, p, availability.slotsMany);
  const helper = createAssistant({ db, core });
  for (const k of Object.keys(helper)) if (k in core) throw new Error(`Two domain functions are named ${k}`);
  Object.assign(core, helper);

  return { core, payments, admin, metrics, partners, stage, events, config, db };
}
