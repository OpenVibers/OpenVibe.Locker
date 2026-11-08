'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function check(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) check(file);
        else if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    }
}
for (const dir of ['server', 'public/js', 'test', 'scripts']) if (fs.existsSync(dir)) check(dir);
console.log('JavaScript syntax checked.');
