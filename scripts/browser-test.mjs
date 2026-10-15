import { execFileSync } from 'node:child_process';
// Run against one dedicated browser/profile at a time. Each child preserves
// NICO_TEST_CDP; OPFS targets are real disk files, not in-memory substitutes.
for(const args of [['scripts/stream-test.mjs','sm9','off'],['scripts/stream-test.mjs','sm9','on'],['scripts/cancel-test.mjs']]) {
  execFileSync(process.execPath,args,{stdio:'inherit',env:process.env});
}
