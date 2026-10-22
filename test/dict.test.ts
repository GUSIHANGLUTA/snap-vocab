/** 词性与释义解析、屈折还原、词库查询。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  Dict,
  damerauDistance,
  flattenMeanings,
  normalizeKey,
  parseTranslation,
  ruleCandidates,
  summarizeGroups,
} from '../src/dict.ts';
import { DICT_FILE, parseExchangeForms, parseTags } from '../src/dict-build.ts';

test('parseTranslation：拆出词性分组并保留顺序', () => {
  const groups = parseTranslation('n. 跑, 赛跑\nvi. 跑, 运转\nvt. 使跑');
  assert.deepEqual(
    groups.map((g) => g.posZh),
    ['名词', '不及物动词', '及物动词'],
  );
  assert.deepEqual(groups[0].meanings, ['跑', '赛跑']);
});

test('parseTranslation：方括号领域标签归到 domain，不算词性', () => {
  const groups = parseTranslation('[计] 运行\n[网络] 屏幕');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].domain, '计算机');
  assert.equal(groups[0].posZh, '其他');
  assert.deepEqual(groups[0].meanings, ['运行']);
});

test('parseTranslation：词性后面挂领域标签时都能识别', () => {
  const groups = parseTranslation('n. [医] 炎症, 红肿');
  assert.equal(groups[0].posZh, '名词');
  assert.equal(groups[0].domain, '医学');
  assert.deepEqual(groups[0].meanings, ['炎症', '红肿']);
});

test('parseTranslation：无词性的说明行归到「其他」', () => {
  const groups = parseTranslation('run的过去式和过去分词');
  assert.equal(groups[0].posZh, '其他');
  assert.match(groups[0].meanings[0], /run的过去式/);
});

test('parseTranslation：空输入返回空数组', () => {
  assert.deepEqual(parseTranslation(''), []);
  assert.deepEqual(parseTranslation(null), []);
});

test('summarizeGroups / flattenMeanings 不为空且带词性前缀', () => {
  const groups = parseTranslation('n. 研究\nv. 学习');
  assert.match(summarizeGroups(groups), /名词: 研究/);
  const flat = flattenMeanings(groups);
  assert.deepEqual(flat, ['名词 研究', '动词 学习']);
});

test('normalizeKey：大小写、所有格、标点、全角撇号', () => {
  assert.equal(normalizeKey('  Screens  '), 'screens');
  assert.equal(normalizeKey("Companies'"), 'companies');
  assert.equal(normalizeKey('don’t'), "don't");
  assert.equal(normalizeKey('“Hello,”'), 'hello');
  assert.equal(normalizeKey('—'), '');
});

test('ruleCandidates：ing / ed / ies / ly 等规则还原', () => {
  assert.ok(ruleCandidates('studies').includes('study'));
  assert.ok(ruleCandidates('running').includes('run'));
  assert.ok(ruleCandidates('hoping').includes('hope'));
  assert.ok(ruleCandidates('cars').includes('car'));
  assert.ok(ruleCandidates('quickly').includes('quick'));
  assert.ok(!ruleCandidates('run').includes('run'));
});

test('parseTags：ECDICT 缩写转中文标签', () => {
  assert.deepEqual(parseTags('zk gk cet4'), ['中考', '高考', '四级']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(undefined), []);
});

test('parseExchangeForms：忽略 0:/1: 这类派生标记与单字母', () => {
  const forms = parseExchangeForms('p:ran/i:running/d:run/0:run/1:d/3:runs/s:runs');
  assert.deepEqual(forms, ['ran', 'running', 'run', 'runs']);
});

const dictReady = existsSync(DICT_FILE);

test('Dict 查询：常见词、屈折还原与未收录', { skip: !dictReady && '词库未构建（npm run dict:build）' }, () => {
  const dict = new Dict();
  dict.open();
  try {
    assert.ok(dict.wordCount > 400000, `词条数偏少：${dict.wordCount}`);

    const hello = dict.lookup('hello');
    assert.equal(hello.found, true);
    assert.equal(hello.source, 'local');
    assert.ok(hello.groups.some((g) => g.posZh === '感叹词'));
    assert.ok(hello.phonetic);

    const run = dict.lookup('run');
    assert.equal(run.found, true);
    assert.deepEqual(
      run.groups.slice(0, 3).map((g) => g.posZh),
      ['名词', '不及物动词', '及物动词'],
    );

    // 屈折形：库里虽然有 screens 这条，但要还原到 screen 并带上 tag/音标
    const screens = dict.lookup('screens');
    assert.equal(screens.found, true);
    assert.equal(screens.lemma, 'screen');
    assert.equal(screens.matchedForm, 'screens');
    assert.ok(screens.tags.includes('中考'));

    const ran = dict.lookup('RAN');
    assert.equal(ran.lemma, 'run');

    const missing = dict.lookup('zzzznotaword');
    assert.equal(missing.found, false);
    assert.equal(missing.source, 'none');
    assert.ok(missing.hint);
  } finally {
    dict.close();
  }
});

test('Dict.lookupMany：去重且保序', { skip: !dictReady && '词库未构建' }, () => {
  const dict = new Dict();
  dict.open();
  try {
    const results = dict.lookupMany(['Run', 'run', 'screens', 'hello']);
    assert.deepEqual(
      results.map((r) => r.key),
      ['run', 'screens', 'hello'],
    );
  } finally {
    dict.close();
  }
});

test('Dict.isLookupCandidate：过滤纯数字与符号', () => {
  assert.equal(Dict.isLookupCandidate('hello'), true);
  assert.equal(Dict.isLookupCandidate("don't"), true);
  assert.equal(Dict.isLookupCandidate('12345'), false);
  assert.equal(Dict.isLookupCandidate('——'), false);
});

test('damerauDistance：增删改与相邻字母互换都算 1 步', () => {
  assert.equal(damerauDistance('recieve', 'receive', 2), 1); // ie -> ei 互换
  assert.equal(damerauDistance('abc', 'abd', 2), 1); // 改一个字母
  assert.equal(damerauDistance('abc', 'ab', 2), 1); // 少一个字母
  assert.equal(damerauDistance('abc', 'abcd', 2), 1); // 多一个字母
  assert.equal(damerauDistance('abc', 'xyz', 2), 3); // 超过上限时返回 max+1
  assert.equal(damerauDistance('abc', 'abc', 2), 0);
});

test('Dict.suggest：常见拼写错误能纠正到正确的词', { skip: !dictReady && '词库未构建' }, () => {
  const dict = new Dict();
  dict.open();
  try {
    const cases: Array<[string, string]> = [
      ['procastinate', 'procrastinate'],
      ['recieve', 'receive'],
      ['consolidaton', 'consolidation'],
      ['recomend', 'recommend'],
      ['seperate', 'separate'],
      ['enviroment', 'environment'],
      ['exacerbat', 'exacerbate'],
      ['concensus', 'consensus'],
    ];
    for (const [typo, expected] of cases) {
      const suggestion = dict.suggest(typo);
      assert.equal(suggestion?.word, expected, `${typo} 应纠正为 ${expected}，实际 ${suggestion?.word}`);
      assert.ok((suggestion?.distance ?? 9) <= 2);
    }

    // 本来就是正确拼写（含屈折还原）的，不该被“纠正”
    assert.equal(dict.suggest('hello'), null);
    assert.equal(dict.suggest('run'), null);
    assert.equal(dict.suggest('screens'), null);
    // 完全没意义的串不给建议
    assert.equal(dict.suggest('qwzxvbn'), null);
    // 太短的词不猜
    assert.equal(dict.suggest('te'), null);
  } finally {
    dict.close();
  }
});

test('Dict.lookup：未收录时带上拼写建议，收录时没有 suggestion', { skip: !dictReady && '词库未构建' }, () => {
  const dict = new Dict();
  dict.open();
  try {
    const missing = dict.lookup('procastinate');
    assert.equal(missing.found, false);
    assert.equal(missing.suggestion?.word, 'procrastinate');

    const found = dict.lookup('procrastinate');
    assert.equal(found.found, true);
    assert.equal(found.suggestion, undefined);
  } finally {
    dict.close();
  }
});

