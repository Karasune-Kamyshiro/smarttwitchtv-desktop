// Dev-only: headless smoke test driver. Enabled with STV_SMOKE=<output dir>.
// STV_SMOKE_STEPS='[["wait",8000],["shot","home"],["key","Down"],["eval","1+1"]]'
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = function smoke(win) {
    const out = process.env.STV_SMOKE;
    fs.mkdirSync(out, { recursive: true });
    const log = fs.createWriteStream(path.join(out, 'console.log'));
    const wc = win.webContents;
    wc.on('console-message', (e) => log.write(`[${e.level}] ${e.message}\n`));
    wc.on('render-process-gone', (_e, d) => log.write(`[crash] ${JSON.stringify(d)}\n`));

    const steps = JSON.parse(process.env.STV_SMOKE_STEPS || '[["wait",10000],["shot","home"]]');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    wc.once('did-finish-load', async () => {
        for (const [kind, arg, arg2] of steps) {
            try {
                if (kind === 'wait') await sleep(arg);
                else if (kind === 'key') {
                    wc.sendInputEvent({ type: 'keyDown', keyCode: arg });
                    wc.sendInputEvent({ type: 'keyUp', keyCode: arg });
                    await sleep(arg2 || 600);
                } else if (kind === 'shot') {
                    const img = await wc.capturePage();
                    fs.writeFileSync(path.join(out, `${arg}.png`), img.toPNG());
                    log.write(`[shot] ${arg}\n`);
                } else if (kind === 'eval') {
                    const r = await wc.executeJavaScript(arg);
                    log.write(`[eval] ${arg.slice(0, 80)} => ${JSON.stringify(r)}\n`);
                }
            } catch (e) {
                log.write(`[step-error] ${kind} ${e}\n`);
            }
        }
        log.end(() => require('electron').app.quit());
    });
};
