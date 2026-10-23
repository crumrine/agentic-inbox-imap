# Copyright (c) 2026 Brian Crumrine
# SPDX-License-Identifier: Apache-2.0
# Run one unchanged SPA regression and viewport in a bounded local session.
import json, os, pathlib, signal, socket, subprocess, sys, time
root=pathlib.Path.cwd(); out=root.parent/'implementation-v4-evidence'
name,width=sys.argv[1:]
assert name in ['list','thread','search'] and width in ['1440','390']
env=dict(os.environ, CHROME_PATH='/home/brian/r9-jobs/home/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', LD_LIBRARY_PATH='/tmp/dev-860-apt/root/usr/lib/x86_64-linux-gnu', XDG_CONFIG_HOME='/tmp/dev-879-browser-config', XDG_CACHE_HOME='/tmp/dev-879-browser-cache', FONTCONFIG_FILE='/tmp/dev-879-browser-config/fontconfig/fonts.conf', BROWSER_WIDTHS=width)
run=name+'-'+width; target=out/run;target.mkdir(exist_ok=True)
with (target/'server.log').open('w') as serverlog:
 server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--config','test/browser/vite.config.mjs'],env=env,stdout=serverlog,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  for attempt in range(30):
   try:
    with socket.create_connection(('127.0.0.1',5189),timeout=1): break
   except OSError:
    assert server.poll() is None, 'fixture server exited'
    time.sleep(1)
  else: raise RuntimeError('fixture server did not listen')
  started=time.monotonic()
  with (target/'run.log').open('w') as log:
   result=subprocess.run(['node','scripts/quarantine-'+name+'-browser.mjs'],env=dict(env,EVIDENCE_DIR=str(target)),stdout=log,stderr=subprocess.STDOUT,timeout=210)
  record={'name':name,'width':int(width),'exit':result.returncode,'seconds':round(time.monotonic()-started,2)}
  (target/'execution.json').write_text(json.dumps(record,indent=2)+'\n'); print(json.dumps(record),flush=True)
  assert result.returncode==0,run
 finally:
  os.killpg(server.pid,signal.SIGTERM)
  try: server.wait(timeout=10)
  except subprocess.TimeoutExpired:
   os.killpg(server.pid,signal.SIGKILL);server.wait()
