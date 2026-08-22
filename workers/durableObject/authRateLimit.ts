// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox brute-force limiter for the IMAP gateway's `/auth` password
 * oracle.
 *
 * ## Why a Durable Object
 *
 * `/api/imap/v1/auth` is the one endpoint in this app that will say yes or no
 * to a guessed secret, so the bound on guesses has to be real rather than
 * best-effort. The options in this architecture:
 *
 * - An isolate-local `Map`. Free, and worthless: Workers isolates are created
 *   and discarded per colo, per eviction. An attacker gets a fresh budget on
 *   every cold start and every PoP they can reach.
 * - R2. No compare-and-swap on a counter, so concurrent attempts race and the
 *   count under-reports exactly when it matters — under a burst.
 * - Cloudflare's native rate-limiting binding. Cheapest, but it is per-colo by
 *   design, so a distributed attacker multiplies the limit by the number of
 *   PoPs, and it is not exercisable in the vitest pool, so the limit would ship
 *   untested.
 * - A Durable Object. One instance per mailbox id, globally single-threaded,
 *   with input gating serialising the read-modify-write for free. Every attempt
 *   against a given mailbox is counted in exactly one place regardless of which
 *   colo it entered through.
 *
 * The DO costs one extra round trip on the auth path. That is the correct
 * trade for the one endpoint whose whole job is to be guessable, and it is
 * dwarfed by the PBKDF2 derivation that follows it.
 *
 * ## Precedent
 *
 * `MailboxDO.checkSendRateLimit()` already does per-mailbox limiting by
 * counting rows in the mailbox's own SQLite. That works there because the
 * thing being limited (sent mail) is already persisted as rows. Failed logins
 * are not persisted anywhere and must not be — a table of failed password
 * attempts is a table of near-miss passwords — so this keeps a counter, not a
 * log, and stores nothing about the attempt beyond the fact that it happened.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/** Failed attempts allowed per mailbox per window before `/auth` starts refusing. */
export const AUTH_FAILURE_LIMIT = 10;

/** Fixed window, in milliseconds. */
export const AUTH_WINDOW_MS = 15 * 60 * 1000;

interface WindowState {
	/** Epoch ms when the current window opened. */
	windowStart: number;
	/** Failed attempts recorded in the current window. */
	failures: number;
	/**
	 * Window length, in ms, in effect for this window. Persisted alongside the
	 * counter so `peek()` and `alarm()` -- neither of which take a `windowMs`
	 * argument -- agree with whatever window `consume()` actually armed,
	 * instead of assuming the `AUTH_WINDOW_MS` default. See the module-level
	 * note on `consume()` for why this matters.
	 */
	windowMs: number;
}

export interface RateLimitDecision {
	allowed: boolean;
	/** Seconds until the current window rolls over. 0 when allowed. */
	retryAfterSeconds: number;
}

/** Exported for tests: seeding/inspecting storage directly to control window
 * age without waiting on real time or mocking the clock. */
export const STATE_KEY = "window";

export class ImapAuthRateLimitDO extends DurableObject<Env> {
	/**
	 * Record one authentication attempt and report whether it may proceed.
	 *
	 * Called *before* the password is checked, so an attempt that is abandoned
	 * mid-flight still costs the attacker budget. `reset()` gives the budget
	 * back on a successful login, which is what keeps a legitimate mail client
	 * reconnecting all day from ever reaching the limit.
	 */
	async consume(
		limit: number = AUTH_FAILURE_LIMIT,
		windowMs: number = AUTH_WINDOW_MS,
	): Promise<RateLimitDecision> {
		const now = Date.now();
		const stored = await this.ctx.storage.get<WindowState>(STATE_KEY);

		// An in-progress window's own `windowMs` (not this call's parameter)
		// decides whether it has expired: once a window is armed, its length
		// is fixed for its lifetime, and `peek()`/`alarm()` need to agree with
		// that same length without being passed it. A brand-new window uses
		// the `windowMs` this call was given.
		const state: WindowState =
			stored && now - stored.windowStart < stored.windowMs
				? stored
				: { windowStart: now, failures: 0, windowMs };

		if (state.failures >= limit) {
			const retryAfterMs = state.windowStart + state.windowMs - now;
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
			};
		}

		state.failures += 1;
		await this.ctx.storage.put(STATE_KEY, state);
		// Self-clean: an idle limiter deletes its own storage once the window is
		// over, so a spray across many made-up mailbox ids cannot leave a
		// permanent DO-per-id footprint behind.
		await this.ctx.storage.setAlarm(state.windowStart + state.windowMs + 1000);

		return { allowed: true, retryAfterSeconds: 0 };
	}

	/** Clear the failure budget. Called only after a password actually verified. */
	async reset(): Promise<void> {
		await this.ctx.storage.delete(STATE_KEY);
	}

	/** Test/ops helper: current failure count without consuming budget. */
	async peek(): Promise<number> {
		const stored = await this.ctx.storage.get<WindowState>(STATE_KEY);
		if (!stored) return 0;
		if (Date.now() - stored.windowStart >= stored.windowMs) return 0;
		return stored.failures;
	}

	override async alarm(): Promise<void> {
		const stored = await this.ctx.storage.get<WindowState>(STATE_KEY);
		if (!stored) return;
		if (Date.now() - stored.windowStart >= stored.windowMs) {
			await this.ctx.storage.deleteAll();
			return;
		}
		// Window was refreshed since the alarm was set; re-arm for the new one.
		await this.ctx.storage.setAlarm(stored.windowStart + stored.windowMs + 1000);
	}
}

/** Resolve the limiter instance for a mailbox. Keyed by mailbox id, nothing else. */
export function authRateLimiter(
	env: Pick<Env, "IMAP_AUTH_RATE_LIMIT">,
	mailboxId: string,
): DurableObjectStub<ImapAuthRateLimitDO> {
	const ns = env.IMAP_AUTH_RATE_LIMIT;
	return ns.get(ns.idFromName(`imap-auth:${mailboxId}`));
}
