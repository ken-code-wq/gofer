/**
 * Take over / hand back. While a goal runs the user can take the browser back for a moment (a
 * login, a captcha, a choice only they can make); the goal can ask for the same thing itself
 * (step status "need_user"). States:
 *
 *   idle --request("user")--> requested --(goal reaches its next step) pause()--> paused
 *   idle --request("need_user", msg)----------------------------------------> paused (via pause())
 *   requested --handBack()--> idle            (changed their mind before it paused)
 *   paused --handBack()--> idle               (pause() resolves { resumed: true })
 *   any --cancel()--> idle                    (goal ended / Stop: pause() resolves { cancelled: true })
 */
import { EventEmitter } from "node:events";

export const HANDBACK_NOTE =
  "The user took over the browser for a moment and has now handed control back to you. They may have logged in, " +
  "solved a captcha or changed the page: look at the current page again and continue the goal from where things are now.";

export class Takeover extends EventEmitter {
  constructor() {
    super();
    this.state = "idle"; // idle | requested | paused
    this.reason = null; // "user" | "need_user"
    this.message = "";
    this._resolve = null;
  }

  /** -> true if the state changed. */
  request(reason = "user", message = "") {
    if (this.state !== "idle") return false;
    this.state = "requested";
    this.reason = reason;
    this.message = String(message || "");
    this._changed();
    return true;
  }

  /** The goal loop checks this before every step. */
  get wanted() {
    return this.state === "requested";
  }

  /** Called by the goal loop: wait until the user hands back (or the goal is cancelled). */
  pause() {
    if (this.state === "idle") return Promise.resolve({ resumed: true });
    if (this.state === "paused" && this._wait) return this._wait;
    this.state = "paused";
    this._wait = new Promise((resolve) => (this._resolve = resolve));
    this._changed();
    return this._wait;
  }

  /** -> true if there was something to hand back. */
  handBack() {
    if (this.state === "idle") return false;
    this._finish({ resumed: true });
    return true;
  }

  cancel() {
    if (this.state === "idle") return false;
    this._finish({ cancelled: true });
    return true;
  }

  /** For the panel: null when idle. */
  info() {
    return this.state === "idle" ? null : { state: this.state, reason: this.reason, message: this.message };
  }

  _finish(result) {
    const resolve = this._resolve;
    this.state = "idle";
    this.reason = null;
    this.message = "";
    this._resolve = null;
    this._wait = null;
    resolve?.(result);
    this._changed();
  }

  _changed() {
    this.emit("change", this.info());
  }
}
