// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {defineConfig} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[tailwindcss()],resolve:{alias:{'~':fileURLToPath(new URL('../../app',import.meta.url)),shared:fileURLToPath(new URL('../../shared',import.meta.url))}},server:{host:'127.0.0.1',port:5189,strictPort:true},build:{outDir:'../../.browser-build',emptyOutDir:true}});
