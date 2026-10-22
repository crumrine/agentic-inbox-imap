// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
// Local synthetic harness: actual SPA routes/components/API/query cache. No Worker bindings.
import './fixture.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter,Routes,Route } from 'react-router';
import App from '../../app/root';
import Mailbox from '../../app/routes/mailbox';
import EmailList from '../../app/routes/email-list';
import Search from '../../app/routes/search-results';
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/mailbox/ui@example.test/emails/spam']}><Routes><Route element={<App/>}><Route path="mailbox/:mailboxId" element={<Mailbox/>}><Route path="emails/:folder" element={<EmailList/>}/><Route path="search" element={<Search/>}/></Route></Route></Routes></MemoryRouter>);
