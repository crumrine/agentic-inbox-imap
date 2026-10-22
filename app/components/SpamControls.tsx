// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '~/services/api';
import { useInvalidateEmailData } from '~/queries/emails';
import type { Email } from '~/types';
import { suspiciousText } from 'shared/mail-scope';

export default function SpamControls({mailboxId, email, onMoved}: {mailboxId:string; email:Email; onMoved:()=>void}) {
  const invalidate = useInvalidateEmailData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = useQuery({queryKey:['spam-state',mailboxId,email.id], queryFn:()=>api.spamState(mailboxId,email.id)});
  const sender = email.sender.length <= 512 ? (email.sender.match(/<([^<>]+)>$/)?.[1] ?? email.sender).trim().toLowerCase() : '';
  const validSender = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender) && sender.length <= 254;
  const preference = useQuery({queryKey:['sender-preference',mailboxId,sender],queryFn:()=>api.senderPreference(mailboxId,sender),enabled:validSender});
  // This is a defensive display projection, not permission to trust mail or classifier text.
  const data = state.data as {revision?:number;disposition?:string;assessments?:{status?:string;result?:{heuristicScore?:number;reasons?:{reason?:string}[]}}[]} | undefined;
  const assessment = Array.isArray(data?.assessments) ? data.assessments[0] : undefined;
  const score = assessment?.result?.heuristicScore;
  const reasons = Array.isArray(assessment?.result?.reasons) ? assessment.result.reasons.slice(0,32) : [];
  const status = ['complete','partial','unavailable'].includes(assessment?.status ?? '') ? assessment!.status : 'unknown / unscored';
  async function act(action:()=>Promise<unknown>, moved=false) {
    setBusy(true); setError('');
    try { await action(); await Promise.all([state.refetch(), preference.refetch(), invalidate(mailboxId)]); if(moved) onMoved(); }
    catch { setError('Action failed or changed elsewhere. Refresh and try again.'); await state.refetch(); await preference.refetch(); }
    finally { setBusy(false); }
  }
  const canFeedback = !busy && Number.isInteger(data?.revision);
  const spam = email.folder_id === 'spam';
  return <section aria-label="Spam controls" className="p-4 border-b border-kumo-line space-y-2 text-sm max-h-72 overflow-y-auto shrink-0">
    <p>Sender: {suspiciousText(email.sender,512)}</p>
    <p>Inspection: {status}. {typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? `Heuristic score: ${score} / 100.` : 'No score available.'} Scores are signals, not confidence percentages or proof of safety. Automatic quarantine is disabled.</p>
    <ul>{reasons.map((reason,i)=><li key={i}>{suspiciousText(reason?.reason,160)}</li>)}</ul>
    <p>Manual disposition: {suspiciousText(data?.disposition,32) || 'unknown'}.</p>
    <div className="flex flex-wrap gap-3">
      <button disabled={!canFeedback} onClick={()=>act(()=>api.manualAction(mailboxId,'spam-feedback',{emailId:email.id, disposition:spam?'not_spam':'spam',expectedRevision:data!.revision}),true)}>{spam?'Not spam — move to Inbox':'Mark as spam'}</button>
      {spam && <button disabled={busy} onClick={()=>act(()=>api.moveEmail(mailboxId,email.id,'inbox'),true)}>Rescue to Inbox without feedback</button>}
      {spam && <button disabled={busy} onClick={()=>act(()=>api.updateEmail(mailboxId,email.id,{read:!email.read},'spam'))}>{email.read?'Mark unread':'Mark read'}</button>}
    </div>
    <p>Sender preference: {suspiciousText(preference.data?.preference,16) || 'none'}. Separate from message feedback; never establishes sender identity.</p>
    <div className="flex flex-wrap gap-3">{(['allow','block','none'] as const).map(value=><button key={value} disabled={busy || !validSender || !preference.data} onClick={()=>act(()=>api.manualAction(mailboxId,'sender-preference',{sender,preference:value,expectedRevision:preference.data!.revision}))}>{value==='none'?'Clear sender preference':value==='allow'?'Always allow sender':'Always block sender'}</button>)}</div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
