// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-password hooks.
 *
 * The one rule this file exists to enforce: **the plaintext password never
 * enters the TanStack cache.**
 *
 * A plain `useMutation` would put whatever `mutationFn` returns into
 * `mutation.data`, where it sits in the MutationCache until the mutation is
 * garbage-collected — long after the dialog that showed it is gone, and
 * visible to anything holding the query client (including React Query
 * Devtools). So `useCreateAppPassword` unpacks the response inside
 * `mutationFn`, hands the plaintext straight to the caller's `onSecret`
 * callback, and returns *only* the metadata. `mutation.data` is therefore
 * safe to inspect, and the secret lives exactly as long as the caller's own
 * state does.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { AppPassword } from "~/types";
import { queryKeys } from "./keys";

export function useAppPasswords(mailboxId: string | undefined) {
	return useQuery<AppPassword[]>({
		queryKey: mailboxId
			? queryKeys.appPasswords.list(mailboxId)
			: ["app-passwords", "_disabled"],
		queryFn: () => api.listAppPasswords(mailboxId!),
		enabled: !!mailboxId,
	});
}

interface CreateAppPasswordVariables {
	mailboxId: string;
	label: string;
	/**
	 * Receives the plaintext exactly once. Store it somewhere that is cleared
	 * when the reveal is dismissed — never in a cache, never in storage.
	 */
	onSecret: (password: string) => void;
}

export function useCreateAppPassword() {
	const qc = useQueryClient();
	return useMutation<AppPassword, Error, CreateAppPasswordVariables>({
		mutationFn: async ({ mailboxId, label, onSecret }) => {
			const { password, metadata } = await api.createAppPassword(mailboxId, label);
			onSecret(password);
			// Only the metadata is returned, so only the metadata is cached.
			return metadata;
		},
		onSuccess: (_metadata, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.appPasswords.list(mailboxId) });
		},
	});
}

export function useRevokeAppPassword() {
	const qc = useQueryClient();
	return useMutation<void, Error, { mailboxId: string; id: string }>({
		mutationFn: ({ mailboxId, id }) => api.revokeAppPassword(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.appPasswords.list(mailboxId) });
		},
	});
}
