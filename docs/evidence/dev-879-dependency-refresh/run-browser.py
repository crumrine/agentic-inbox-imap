# Copyright (c) 2026 Brian Crumrine
# SPDX-License-Identifier: Apache-2.0
import json, os, pathlib, signal, socket, subprocess, time
root=pathlib.Path.cwd()
out=root.parent/'implementation-v4-evidence'
env=dict(os.environ, CHROME_PATH='/home/brian/r9-jobs/home/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', LD_LIBRARY_PATH='/tmp/dev-860-apt/root/usr/lib/x86_64-linux-gnu', XDG_CONFIG_HOME='/tmp/dev-879-browser-config', XDG_CACHE_HOME='/tmp/dev-879-browser-cache', FONTCONFIG_FILE='/tmp/dev-879-browser-config/fontconfig/fonts.conf', BROWSER_WIDTHS='1440,390')
records=[]
with (out/'browser-server.log').open('w') as serverlog:
 server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--config','test/browser/vite.config.mjs'],env=env,stdout=serverlog,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  for attempt in range(120):
   try:
    with socket.create_connection(('127.0.0.1',5189),timeout=1): break
   except OSError:
    assert server.poll() is None, 'fixture server exited'
    time.sleep(1)
  else: raise RuntimeError('fixture server did not listen')
  for name,script in [('preview','quarantine-browser.mjs'),('list','quarantine-list-browser.mjs'),('thread','quarantine-thread-browser.mjs'),('search','quarantine-search-browser.mjs')]:
   started=time.monotonic()
   with (out/(name+'.log')).open('w') as log:
    result=subprocess.run(['node','scripts/'+script],env=dict(env,EVIDENCE_DIR=str(out/name)),stdout=log,stderr=subprocess.STDOUT,timeout=300)
   records.append({'name':name,'exit':result.returncode,'seconds':round(time.monotonic()-started,2)})
   (out/'browser-runs.json').write_text(json.dumps(records,indent=2)+'\n')
   print(name,result.returncode,flush=True)
   assert result.returncode==0,name
 finally:
  os.killpg(server.pid,signal.SIGTERM)
  try: server.wait(timeout=10)
  except subprocess.TimeoutExpired:
   os.killpg(server.pid,signal.SIGKILL);server.wait()
