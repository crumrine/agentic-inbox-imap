// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Regression tests for the `peek()`/`alarm()` vs. `consume()` window
 * mismatch in ImapAuthRateLimitDO: `consume(limit, windowMs)` takes an
 * explicit window, but `peek()` and `alarm()` used to hardcode
 * `AUTH_WINDOW_MS` (15 minutes) regardless of what window `consume()` was
 * actually given -- so a caller using a shorter window (only test/ops
 * callers do today) got a `peek()` that reported a stale non-zero count and
 * an `alarm()` that re-armed against the wrong, much longer window.
 *
 * These seed `WindowState` directly via `runInDurableObject` rather than
 * mocking the clock, so they are deterministic without waiting on real time
 * or fighting workerd's own timer implementation.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { authRateLimiter, STATE_KEY } from "../workers/durableObject/authRateLimit";

let n = 0;
function uniqueMailbox(prefix: string): string {
	n += 1;
	return `${prefix}-${n}@example.com`;
}

interface StoredWindow {
	windowStart: number;
	failures: number;
	windowMs: number;
}

describe("ImapAuthRateLimitDO: peek() and alarm() honor consume()'s window", () => {
	it("peek() expires a counter using consume()'s window, not the 15-minute default", async () => {
		const id = uniqueMailbox("peek-window");
		const stub = authRateLimiter(env, id);

		// A 1-minute window with one recorded failure.
		await stub.consume(10, 60_000);
		expect(await stub.peek()).toBe(1);

		// Age the window to 90 seconds old: expired under the 60s window
		// consume() was given, but still "fresh" under the hardcoded
		// 15-minute AUTH_WINDOW_MS peek() used before the fix.
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.get<StoredWindow>(STATE_KEY);
			if (!stored) throw new Error("expected seeded window state");
			await state.storage.put(STATE_KEY, { ...stored, windowStart: Date.now() - 90_000 });
		});

		expect(await stub.peek()).toBe(0);
	});

	it("alarm() clears a counter using consume()'s window, not the 15-minute default", async () => {
		const id = uniqueMailbox("alarm-window");
		const stub = authRateLimiter(env, id);

		await stub.consume(10, 60_000);

		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.get<StoredWindow>(STATE_KEY);
			if (!stored) throw new Error("expected seeded window state");
			await state.storage.put(STATE_KEY, { ...stored, windowStart: Date.now() - 90_000 });
		});

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// A window alarm() correctly recognises as expired must wipe its
		// storage, not re-arm for another 15 minutes.
		const remaining = await runInDurableObject(stub, (_instance, state) => state.storage.get(STATE_KEY));
		expect(remaining).toBeUndefined();
		expect(await stub.peek()).toBe(0);
	});

	it("consume(), peek(), and alarm() all agree on a still-active custom window", async () => {
		const id = uniqueMailbox("agree-window");
		const stub = authRateLimiter(env, id);

		await stub.consume(10, 60_000);
		await stub.consume(10, 60_000);
		expect(await stub.peek()).toBe(2);

		// Only 10s old: well within the 60s window, nowhere near the 15-minute
		// default either, so this alone wouldn't distinguish the bug -- but it
		// guards against an overcorrection that expires an active window too
		// eagerly.
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.get<StoredWindow>(STATE_KEY);
			if (!stored) throw new Error("expected seeded window state");
			await state.storage.put(STATE_KEY, { ...stored, windowStart: Date.now() - 10_000 });
		});

		expect(await stub.peek()).toBe(2);
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);
		expect(await stub.peek()).toBe(2);
	});
});
