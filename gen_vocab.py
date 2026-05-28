import re, json

def esc(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")

def strip_cite(s):
    """Remove [cite: ...] annotations injected by AI tools."""
    return re.sub(r'\s*\[cite:[^\]]*\]', '', s).strip()

with open('detailVocab.json', encoding='utf-8') as f:
    raw = f.read()

# Strip [cite: ...] before parsing JSON
raw = re.sub(r'\s*\[cite:[^\]]*\]', '', raw)
data = json.loads(raw)

pairs = []
idx = 0
for lesson_key, subs in data.items():
    for sub_key, words in subs.items():
        for word in words:
            hiragana  = word.get('hiragana', '').strip()
            vietnamese = word.get('vietnamese', '').strip()
            kanji     = word.get('japanese', '').strip()
            if not hiragana or not vietnamese:
                continue
            pairs.append({
                'id':     'v%d' % idx,
                'front':  hiragana,
                'back':   vietnamese,
                'kanji':  kanji,
                'lesson': lesson_key,
                'sub':    sub_key,
            })
            idx += 1

js_items = []
for p in pairs:
    js_items.append(
        "  {id:'%s',type:'vocab',front:'%s',back:'%s',kanji:'%s',lesson:'%s',sub:'%s'}" % (
            p['id'], esc(p['front']), esc(p['back']),
            esc(p['kanji']), esc(p['lesson']), esc(p['sub'])
        )
    )

out = 'const VOCAB_DATA = [\n' + ',\n'.join(js_items) + '\n];'
with open('vocab_data.js', 'w', encoding='utf-8') as f:
    f.write(out)
print('Written', len(pairs), 'entries to vocab_data.js')
