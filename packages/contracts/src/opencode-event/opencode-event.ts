/**
 * OpenCode mirror event contracts (sdk mirror read side, SSE re-stream).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * OpencodeEventDurable, OpencodeEvent, OpencodeBusEvent, OpencodeGlobalEvent.
 *
 * GET /api/opencode/event relays the v2 bus frames verbatim: the pinned
 * @opencode-ai/sdk v2 `event.subscribe()` parses the upstream SSE envelope
 * and yields the parsed event object — the mirror writes exactly that
 * object as the downstream `data:` frame (opencode.controller.ts relaySse).
 * So the downstream frame is the FLAT event {id, type, data, …} — NOT the
 * raw upstream envelope {event, data:JSON-string} and NOT the legacy
 * GlobalEvent {…payload} wrapper. Shape provenance: live SSE probe of the
 * 2.2.0 stand GET /api/event (`data: {"id":"evt_…","type":"server.connected","data":{}}`)
 * + the sdk V2EventSubscribeResponses.200 = V2Event union.
 *
 * `type` is the discriminator of a large upstream-owned variant union
 * (~100 variants in the pinned sdk). This contract models the stable
 * ENVELOPE (id/type/data + optional durable/location/metadata); per-variant
 * `data` payloads are passed through as unknown records — mirroring every
 * variant is card 4 territory (domain routes decide which events the
 * product actually consumes).
 *
 * GET /api/opencode/global/event relays the LEGACY GlobalEvent wrapper
 * ({directory, project?, workspace?, payload: flat bus event}) — the
 * current 2.2.0 stand does not serve /global/event (SPA catch-all); the
 * shape is carried from the pinned sdk `GlobalEvent`/`Event` types.
 * Consumers switching from the sdk get `OpencodeEvent` where they used the
 * sdk `V2Event`/`Event` union members.
 * Types only — runtime validation lives in opencode-event.schema.ts.
 */
import type { OpencodeLocationRef } from '../opencode-session/opencode-session';

/** Durable-seq marker some upstream variants carry. */
export type OpencodeEventDurable = {
  aggregateID: string;
  seq: number;
  version: number;
};

/**
 * Flat v2 bus event frame as re-streamed by GET /api/opencode/event.
 * `data` = per-type payload (upstream variant), kept as an unknown record.
 */
export type OpencodeEvent = {
  /** upstream event id (evt_…) */
  id: string;
  /** discriminator over the upstream variant union (e.g. 'session.updated') */
  type: string;
  /** per-type payload — upstream-owned, passed through untouched */
  data: {
    [key: string]: unknown;
  };
  /** optional upstream metadata bag */
  metadata?: {
    [key: string]: unknown;
  };
  /** present on durable variants only */
  durable?: OpencodeEventDurable;
  /** present on location-scoped variants */
  location?: OpencodeLocationRef;
};

/**
 * Flat legacy bus event as carried inside GlobalEvent.payload
 * ({id, type, properties}) — shape of the pinned sdk `Event` union.
 * `properties` = per-type payload (upstream variant), passed through untouched.
 */
export type OpencodeBusEvent = {
  id: string;
  type: string;
  properties: {
    [key: string]: unknown;
  };
};

/**
 * Legacy global event frame re-streamed by GET /api/opencode/global/event
 * (upstream GlobalEvent wrapper: routing envelope + flat bus event inside
 * `payload`). The current 2.2.0 stand does not serve /global/event — see
 * the open question in the task report (card 4 decides the replacement).
 */
export type OpencodeGlobalEvent = {
  /** absolute directory the frame belongs to */
  directory: string;
  project?: string;
  workspace?: string;
  payload: OpencodeBusEvent;
};
