// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Address-alias hooks.
 *
 * Nothing secret passes through here, so unlike app-passwords.ts these are
 * plain query/mutation pairs. The one thing worth keeping straight is that an
 * alias is per-mailbox in the cache: the list key is scoped by mailbox id, and
 * every mutation invalidates only that mailbox's list.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Alias } from "~/types";
import { queryKeys } from "./keys";

export function useAliases(mailboxId: string | undefined) {
	return useQuery<Alias[]>({
		queryKey: mailboxId
			? queryKeys.aliases.list(mailboxId)
			: ["aliases", "_disabled"],
		queryFn: () => api.listAliases(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useCreateAlias() {
	const qc = useQueryClient();
	return useMutation<
		Alias,
		Error,
		{ mailboxId: string; address: string; name?: string }
	>({
		mutationFn: ({ mailboxId, address, name }) =>
			api.createAlias(mailboxId, address, name),
		onSuccess: (_alias, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.aliases.list(mailboxId) });
		},
	});
}

/**
 * Set, change or clear an alias's display name.
 *
 * `name: null` clears it back to "not configured" (the client's own display
 * name is used again); `name: ""` configures it as blank, so the address goes
 * out bare. They are different settings and the mutation passes them through
 * unflattened.
 */
export function useSetAliasName() {
	const qc = useQueryClient();
	return useMutation<
		Alias,
		Error,
		{ mailboxId: string; address: string; name: string | null }
	>({
		mutationFn: ({ mailboxId, address, name }) =>
			api.setAliasName(mailboxId, address, name),
		onSuccess: (_alias, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.aliases.list(mailboxId) });
		},
	});
}

export function useDeleteAlias() {
	const qc = useQueryClient();
	return useMutation<void, Error, { mailboxId: string; address: string }>({
		mutationFn: ({ mailboxId, address }) => api.deleteAlias(mailboxId, address),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.aliases.list(mailboxId) });
		},
	});
}
