// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-password management for the Settings route.
 *
 * App passwords are what a mail client authenticates with over IMAP and SMTP.
 * Before this, minting one meant running scripts/mint-app-password.mjs and
 * uploading the result to R2 by hand.
 *
 * ## The plaintext
 *
 * The generated password exists in exactly one place in this component: the
 * `revealed` state below. It is set from the create call's response and
 * cleared by `dismissReveal()`, which every close path of the reveal dialog
 * runs through (button, Escape, backdrop click — Kumo routes them all through
 * `onOpenChange`). It is never written to the query cache (see
 * app/queries/app-passwords.ts), never to storage, and never logged. Once the
 * dialog closes it is unrecoverable, which is why the dialog says so *before*
 * offering a way out of it.
 */

import {
	Badge,
	Banner,
	Button,
	ClipboardText,
	Dialog,
	Input,
	Loader,
} from "@cloudflare/kumo";
import {
	KeyIcon,
	PlusIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
	useAppPasswords,
	useCreateAppPassword,
	useRevokeAppPassword,
} from "~/queries/app-passwords";
import type { AppPassword } from "~/types";

function formatCreated(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

interface RevealedPassword {
	password: string;
	label: string;
}

export default function AppPasswordSettings({ mailboxId }: { mailboxId: string }) {
	const { data: passwords, isLoading, error } = useAppPasswords(mailboxId);
	const createMutation = useCreateAppPassword();
	const revokeMutation = useRevokeAppPassword();

	const [label, setLabel] = useState("");
	const [revealed, setRevealed] = useState<RevealedPassword | null>(null);
	const [copied, setCopied] = useState(false);
	const [pendingRevoke, setPendingRevoke] = useState<AppPassword | null>(null);

	const trimmedLabel = label.trim();

	const handleCreate = (e: React.FormEvent) => {
		e.preventDefault();
		if (!trimmedLabel || createMutation.isPending) return;
		setCopied(false);
		createMutation.mutate({
			mailboxId,
			label: trimmedLabel,
			// The only handoff of the plaintext. It goes to component state and
			// nowhere else.
			onSecret: (password) => setRevealed({ password, label: trimmedLabel }),
		});
		setLabel("");
	};

	/**
	 * Drops the plaintext. Also resets the mutation so nothing about the create
	 * — not even its metadata — is left hanging around in the mutation cache.
	 */
	const dismissReveal = () => {
		setRevealed(null);
		setCopied(false);
		createMutation.reset();
	};

	const handleRevoke = async () => {
		if (!pendingRevoke) return;
		try {
			await revokeMutation.mutateAsync({ mailboxId, id: pendingRevoke.id });
		} finally {
			setPendingRevoke(null);
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<KeyIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					App Passwords
				</span>
				{passwords && passwords.length > 0 && (
					<Badge variant="secondary">{passwords.length}</Badge>
				)}
			</div>

			<p className="text-xs text-kumo-subtle mb-4">
				Mail clients sign in with an app password, not with your Cloudflare
				Access login. Create one per device so you can revoke a single device
				without disturbing the others.
			</p>

			{/* Existing passwords */}
			{isLoading ? (
				<div className="flex justify-center py-6">
					<Loader size="sm" />
				</div>
			) : error ? (
				<Banner
					variant="error"
					className="mb-4"
					title="Could not load app passwords"
					description={error.message}
				/>
			) : !passwords || passwords.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic mb-4 rounded-lg border border-dashed border-kumo-line px-3 py-4 text-center">
					No app passwords yet. Create one below to connect a mail client.
				</p>
			) : (
				<ul className="mb-4 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{passwords.map((entry) => (
						<li
							key={entry.id}
							className="flex items-center justify-between gap-3 px-3 py-2.5"
						>
							<div className="min-w-0">
								<div className="text-sm text-kumo-default truncate">
									{entry.label}
								</div>
								<div className="text-xs text-kumo-subtle font-mono truncate">
									{entry.id} · created {formatCreated(entry.createdAt)}
								</div>
							</div>
							<Button
								variant="ghost"
								size="xs"
								icon={<TrashIcon size={14} />}
								onClick={() => setPendingRevoke(entry)}
							>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}

			{/* Create */}
			<form onSubmit={handleCreate} className="flex items-end gap-2">
				<div className="flex-1">
					<Input
						label="New app password"
						placeholder="e.g. iPhone Mail"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</div>
				<Button
					type="submit"
					variant="primary"
					icon={<PlusIcon size={14} />}
					disabled={!trimmedLabel}
					loading={createMutation.isPending}
				>
					Create
				</Button>
			</form>
			{createMutation.isError && (
				<Banner
					variant="error"
					className="mt-3"
					title="Could not create the app password"
					description={createMutation.error.message}
				/>
			)}

			{/* Setup guidance */}
			<div className="mt-5 rounded-lg border border-kumo-line bg-kumo-recessed p-4">
				<div className="text-xs font-medium text-kumo-default mb-2">
					Mail client setup
				</div>
				<dl className="text-xs text-kumo-subtle space-y-1">
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-kumo-default">Server</dt>
						<dd>the hostname your IMAP gateway is reachable at</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-kumo-default">IMAP port</dt>
						<dd>993, TLS required (implicit TLS)</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-kumo-default">SMTP port</dt>
						<dd>465 for implicit TLS, or 587 with STARTTLS</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-kumo-default">Username</dt>
						<dd className="font-mono break-all">{mailboxId}</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-kumo-default">Password</dt>
						<dd>an app password from the list above</dd>
					</div>
				</dl>
				<p className="text-xs text-kumo-subtle mt-3">
					Plaintext connections are refused. If a client offers "no
					encryption", it will not connect.
				</p>
			</div>

			{/* One-time reveal */}
			<Dialog.Root
				open={revealed !== null}
				onOpenChange={(open) => {
					if (!open) dismissReveal();
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						App password for {revealed?.label}
					</Dialog.Title>
					<Dialog.Description className="text-xs text-kumo-subtle mb-4">
						Paste this into your mail client's password field.
					</Dialog.Description>

					<Banner
						variant="alert"
						icon={<WarningIcon size={16} weight="fill" />}
						title="Copy it now — this is the only time it is shown"
						description="Once you close this dialog the password cannot be retrieved. If you lose it you will have to revoke this one and create another."
						className="mb-4"
					/>

					{revealed && (
						<ClipboardText
							text={revealed.password}
							size="lg"
							className="font-mono"
							onCopy={() => setCopied(true)}
							tooltip={{ text: "Copy password", copiedText: "Copied" }}
						/>
					)}

					<div className="flex justify-end mt-5">
						<Button
							variant={copied ? "primary" : "secondary"}
							onClick={dismissReveal}
						>
							{copied ? "Done" : "Close without copying"}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Revoke confirmation */}
			<Dialog.Root
				open={pendingRevoke !== null}
				onOpenChange={(open) => {
					if (!open && !revokeMutation.isPending) setPendingRevoke(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						Revoke "{pendingRevoke?.label}"?
					</Dialog.Title>
					<Dialog.Description className="text-xs text-kumo-subtle mb-4">
						App password{" "}
						<span className="font-mono text-kumo-default">
							{pendingRevoke?.id}
						</span>
						, created{" "}
						{pendingRevoke ? formatCreated(pendingRevoke.createdAt) : ""}.
					</Dialog.Description>

					<Banner
						variant="alert"
						icon={<WarningIcon size={16} weight="fill" />}
						title="Any device using this password will stop syncing"
						description="The failure shows up later, on the device, as a login error. Make sure this is the one you meant."
						className="mb-4"
					/>

					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							onClick={() => setPendingRevoke(null)}
							disabled={revokeMutation.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleRevoke}
							loading={revokeMutation.isPending}
						>
							Revoke
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
