import test from 'node:test';
import assert from 'node:assert/strict';

test('the theme button: the first click always changes what the page looks like', async () => {
  const { nextTheme } = await import('../src/app/shell/look.js');
  for (const osDark of [false, true]) {
    const first = nextTheme('system', osDark);
    assert.equal(first, osDark ? 'light' : 'dark', 'leaves System for the look the OS lacks');
    const second = nextTheme(first, osDark);
    assert.equal(second, osDark ? 'dark' : 'light');
    assert.equal(nextTheme(second, osDark), 'system');
  }
});

test('little room: a high zoom or a small window is tight', async () => {
  const { tight, ZOOM_STEPS } = await import('../src/app/shell/look.js');
  assert.equal(tight(1440, 1), false);
  assert.equal(tight(1440, 1.6), true);
  assert.equal(tight(1000, 1), true);
  assert.deepEqual([...ZOOM_STEPS].filter((z) => tight(1440, z)), [1.4, 1.6]);
});
