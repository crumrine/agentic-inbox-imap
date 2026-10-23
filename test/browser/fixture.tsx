// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
// Local synthetic harness: actual SPA routes/components/API/query cache. No Worker bindings.
import './fixture.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter,Routes,Route,Outlet } from 'react-router';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {TooltipProvider,Toasty} from '@cloudflare/kumo';
// Match the production query provider, including two retries for server errors.
import { ApiError } from '../../app/services/api';
const client=new QueryClient({defaultOptions:{queries:{staleTime:30000,retry:(failureCount,error)=>!(error instanceof ApiError && error.status>=400 && error.status<500) && failureCount<2,refetchOnWindowFocus:false}}});
function Providers(){return <QueryClientProvider client={client}><TooltipProvider><Toasty><Outlet/></Toasty></TooltipProvider></QueryClientProvider>;}
import Mailbox from '../../app/routes/mailbox';
import EmailList from '../../app/routes/email-list';
import Search from '../../app/routes/search-results';
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/mailbox/ui@example.test/emails/spam']}><Routes><Route element={<Providers/>}><Route path="mailbox/:mailboxId" element={<Mailbox/>}><Route path="emails/:folder" element={<EmailList/>}/><Route path="search" element={<Search/>}/></Route></Route></Routes></MemoryRouter>);
