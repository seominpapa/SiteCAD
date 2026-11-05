import test from 'node:test';
import assert from 'node:assert/strict';
import { skillShareDownload, isAllowedSkillShareMail } from '../desktop/runtime.mjs';

test('desktop accepts a named skill ZIP only from its own blob download', () => {
  const base = 'http://127.0.0.1:1234';
  assert.equal(skillShareDownload('SiteCAD-skills-0.16.4-20261105.zip', `blob:${base}/uuid`, base), true);
  for (const name of ['../SiteCAD-skills-0.16.4-20261105.zip', 'arbitrary.zip', 'SiteCAD-skills-0.16.4-20261105.zip.exe']) assert.equal(skillShareDownload(name, `blob:${base}/uuid`, base), false);
  for (const url of ['https://evil.test/file.zip', 'blob:http://127.0.0.1:12345/uuid', 'blob:https://evil.test/uuid']) assert.equal(skillShareDownload('SiteCAD-skills-0.16.4-20261105.zip', url, base), false);
});

test('email compose opens only the fixed support recipient without arbitrary headers', () => {
  assert.equal(isAllowedSkillShareMail('mailto:seominpapa@gmail.com?subject=SiteCAD&body=Attach%20ZIP'), true);
  for (const url of ['mailto:elsewhere@example.com', 'mailto:seominpapa@gmail.com?bcc=elsewhere@example.com', 'mailto:seominpapa@gmail.com,elsewhere@example.com', 'https://example.com', 'invalid', 'mailto:seominpapa@gmail.com?subject=hello%0D%0ABcc%3Aevil', 'mailto:seominpapa@gmail.com#fragment']) assert.equal(isAllowedSkillShareMail(url), false);
});
