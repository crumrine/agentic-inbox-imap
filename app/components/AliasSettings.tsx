// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Address-alias management for the Settings route.
 *
 * An alias is two things at once and the card has to say both, because getting
 * either one wrong has consequences the user cannot see from here: mail sent to
 * the alias lands in this mailbox, and this mailbox is allowed to send as the
 * alias. The removal dialog spells out both halves for the same reason — a
 * removed alias stops delivering (mail to it is dropped, not bounced into some
 * other mailbox) and stops being a permitted From address.
 *
 * ## The display name has three states, and the UI says which one it is in
 *
 * `undefined` (nothing configured), `""` (configured blank) and a real name are
 * three different settings, not two — see `AliasDisplayName` in
 * workers/lib/aliases.ts. Collapsing "not configured" and "blank" into one
 * empty text box would make it impossible to say "send a bare address" as
 * distinct from "leave it to the mail client", so the dialog offers the two as
 * separate, named actions and every row states which state it is in.
 *
 * ## A wildcard has to read as a wildcard, not as a broken address
 *
 * `brian@` is a real, deliberate setting — every domain this deployment
 * handles, no per-domain record — and on screen it is one character away from
 * an address someone failed to finish typing. So it never appears on its own:
 * the row labels it "all domains", the dialogs say which domains it affects,
 * and the removal warning says the thing that is actually at stake, which is
 * that mail stops arriving on every domain at once rather than on one.
 */

import {
	Badge,
	Banner,
	Button,
	Dialog,
	Input,
	Loader,
} from "@cloudflare/kumo";
import {
	AtIcon,
	PencilSimpleIcon,
	PlusIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
	useAliases,
	useCreateAlias,
	useDeleteAlias,
	useSetAliasName,
} from "~/queries/aliases";
import type { Alias } from "~/types";

function formatCreated(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/**
 * Whether this alias is a domain wildcard.
 *
 * A trailing `@` is the whole test, and it cannot be confused with a real
 * address: one always has a dotted domain after its `@`. Mirrors
 * `isWildcardAlias` in workers/lib/aliases.ts, which is on the other side of
 * the API boundary and cannot be imported here.
 */
function isWildcard(alias: Alias): boolean {
	return alias.address.endsWith("@");
}

/** The alias's scope, for the places that have room to say it in words. */
function describeScope(alias: Alias): string {
	return isWildcard(alias) ? "on every domain" : "";
}

/** How a row describes the alias's display-name state, in words. */
function describeName(alias: Alias): string {
	if (alias.name === undefined) return "uses your mailbox name";
	if (alias.name === "") return "sends with no display name";
	return `sends as "${alias.name}"`;
}

export default function AliasSettings({ mailboxId }: { mailboxId: string }) {
	const { data: aliases, isLoading, error } = useAliases(mailboxId);
	const createMutation = useCreateAlias();
	const deleteMutation = useDeleteAlias();
	const nameMutation = useSetAliasName();

	const [address, setAddress] = useState("");
	const [newName, setNewName] = useState("");
	const [pendingDelete, setPendingDelete] = useState<Alias | null>(null);
	const [pendingName, setPendingName] = useState<Alias | null>(null);
	const [draftName, setDraftName] = useState("");

	const trimmed = address.trim();
	const trimmedNewName = newName.trim();
	const trimmedDraft = draftName.trim();

	const handleCreate = (e: React.FormEvent) => {
		e.preventDefault();
		if (!trimmed || createMutation.isPending) return;
		createMutation.mutate(
			{
				mailboxId,
				address: trimmed,
				// Omitted, not empty: an empty box at creation means "say
				// nothing about the display name", which is not the same as
				// configuring it blank.
				...(trimmedNewName ? { name: trimmedNewName } : {}),
			},
			{
				onSuccess: () => {
					setAddress("");
					setNewName("");
				},
			},
		);
	};

	const openNameDialog = (alias: Alias) => {
		setDraftName(alias.name ?? "");
		setPendingName(alias);
	};

	const applyName = async (name: string | null) => {
		if (!pendingName) return;
		try {
			await nameMutation.mutateAsync({
				mailboxId,
				address: pendingName.address,
				name,
			});
			setPendingName(null);
		} catch {
			// The banner in the dialog renders the error; keep it open so the
			// typed name is not lost.
		}
	};

	const handleDelete = async () => {
		if (!pendingDelete) return;
		try {
			await deleteMutation.mutateAsync({
				mailboxId,
				address: pendingDelete.address,
			});
		} finally {
			setPendingDelete(null);
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<AtIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Address Aliases
				</span>
				{aliases && aliases.length > 0 && (
					<Badge variant="secondary">{aliases.length}</Badge>
				)}
			</div>

			<p className="text-xs text-kumo-subtle mb-4">
				An alias is another address for this mailbox. Mail sent to it is
				delivered here, and this mailbox is allowed to send as it. Without an
				alias, mail to an address with no mailbox of its own is dropped.
			</p>

			<p className="text-xs text-kumo-subtle mb-4">
				Leave off the domain — just <span className="font-mono">brian@</span> —
				and the alias covers that name on every domain this deployment
				receives mail for, with no per-domain entry. A specific address always
				wins over a wildcard, so <span className="font-mono">brian@</span> does
				not take mail away from a mailbox or an alias that names the address in
				full.
			</p>

			{isLoading ? (
				<div className="flex justify-center py-6">
					<Loader size="sm" />
				</div>
			) : error ? (
				<Banner
					variant="error"
					className="mb-4"
					title="Could not load aliases"
					description={error.message}
				/>
			) : !aliases || aliases.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic mb-4 rounded-lg border border-dashed border-kumo-line px-3 py-4 text-center">
					No aliases yet. Add one below to receive and send as another address.
				</p>
			) : (
				<ul className="mb-4 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{aliases.map((alias) => (
						<li
							key={alias.address}
							className="flex items-center justify-between gap-3 px-3 py-2.5"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-2 min-w-0">
									<span className="text-sm text-kumo-default font-mono truncate">
										{alias.address}
									</span>
									{/* Without this the row reads as a half-typed
									    address. The badge is what makes `brian@`
									    legible as a setting. */}
									{isWildcard(alias) && (
										<Badge variant="secondary">all domains</Badge>
									)}
								</div>
								<div className="text-xs text-kumo-subtle truncate">
									delivers here{isWildcard(alias) ? " " + describeScope(alias) : ""} ·{" "}
									{describeName(alias)} · added {formatCreated(alias.createdAt)}
								</div>
							</div>
							<div className="flex items-center gap-1 shrink-0">
								<Button
									variant="ghost"
									size="xs"
									icon={<PencilSimpleIcon size={14} />}
									onClick={() => openNameDialog(alias)}
								>
									Name
								</Button>
								<Button
									variant="ghost"
									size="xs"
									icon={<TrashIcon size={14} />}
									onClick={() => setPendingDelete(alias)}
								>
									Remove
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}

			<form onSubmit={handleCreate} className="flex items-end gap-2">
				<div className="flex-1">
					{/* Not type="email": the browser's own validation refuses
					    `brian@`, which is a wildcard rather than an unfinished
					    address. The server validates both shapes. */}
					<Input
						label="New alias"
						type="text"
						placeholder="e.g. info@example.com or brian@"
						value={address}
						onChange={(e) => setAddress(e.target.value)}
					/>
				</div>
				<div className="flex-1">
					<Input
						label="Display name (optional)"
						type="text"
						placeholder="e.g. Acme Info"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
					/>
				</div>
				<Button
					type="submit"
					variant="primary"
					icon={<PlusIcon size={14} />}
					disabled={!trimmed}
					loading={createMutation.isPending}
				>
					Add
				</Button>
			</form>
			{createMutation.isError && (
				<Banner
					variant="error"
					className="mt-3"
					title="Could not add the alias"
					description={createMutation.error.message}
				/>
			)}

			<p className="text-xs text-kumo-subtle mt-4">
				The address has to be one this deployment receives mail for, and it
				cannot already be a mailbox or an alias of another mailbox. To move an
				alias between mailboxes, remove it from the first one first. A display
				name can be added or changed at any time, wildcards included.
			</p>

			<Dialog.Root
				open={pendingName !== null}
				onOpenChange={(open) => {
					if (!open && !nameMutation.isPending) setPendingName(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						Display name for "{pendingName?.address}"
					</Dialog.Title>
					<Dialog.Description className="text-xs text-kumo-subtle mb-4">
						What recipients see beside the address on mail sent from it. Set one
						to keep a personal name off a shared address.
						{pendingName && isWildcard(pendingName)
							? " This one applies on every domain the wildcard covers."
							: ""}
					</Dialog.Description>

					<Input
						label="Display name"
						type="text"
						placeholder="e.g. Acme Info"
						value={draftName}
						onChange={(e) => setDraftName(e.target.value)}
					/>

					<p className="text-xs text-kumo-subtle mt-3">
						Currently {pendingName ? describeName(pendingName) : ""}.
					</p>

					{nameMutation.isError && (
						<Banner
							variant="error"
							className="mt-3"
							title="Could not save the display name"
							description={nameMutation.error.message}
						/>
					)}

					<div className="flex flex-wrap justify-end gap-2 mt-4">
						<Button
							variant="secondary"
							onClick={() => setPendingName(null)}
							disabled={nameMutation.isPending}
						>
							Cancel
						</Button>
						{/* `null` clears the setting; the mail client's own display
						    name is used again. Only offered when there is one to
						    clear, so the two empty-ish choices cannot be confused. */}
						{pendingName?.name !== undefined && (
							<Button
								variant="secondary"
								onClick={() => void applyName(null)}
								disabled={nameMutation.isPending}
							>
								Use mailbox name
							</Button>
						)}
						{/* `""` is a setting, not the absence of one: send a bare
						    address, with no display name at all. */}
						<Button
							variant="secondary"
							onClick={() => void applyName("")}
							disabled={nameMutation.isPending || pendingName?.name === ""}
						>
							No display name
						</Button>
						<Button
							variant="primary"
							onClick={() => void applyName(trimmedDraft)}
							loading={nameMutation.isPending}
							disabled={!trimmedDraft}
						>
							Save
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open && !deleteMutation.isPending) setPendingDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						Remove "{pendingDelete?.address}"?
					</Dialog.Title>
					<Dialog.Description className="text-xs text-kumo-subtle mb-4">
						Added {pendingDelete ? formatCreated(pendingDelete.createdAt) : ""}.
						Mail already delivered stays in this mailbox.
					</Dialog.Description>

					<Banner
						variant="alert"
						icon={<WarningIcon size={16} weight="fill" />}
						title={
							pendingDelete && isWildcard(pendingDelete)
								? "New mail to this name will be dropped on every domain"
								: "New mail to this address will be dropped"
						}
						description="It stops delivering here and stops being an address this mailbox can send as. Senders are not told; the message is simply not accepted."
						className="mb-4"
					/>

					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							onClick={() => setPendingDelete(null)}
							disabled={deleteMutation.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleDelete}
							loading={deleteMutation.isPending}
						>
							Remove
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
