import re

with open('New words list - Dekiru Nihongo Beginner.txt', encoding='utf-8') as f:
    text = f.read()

text = text.replace('\r\n', '\n').replace('\r', '\n')
blocks = [b.strip() for b in re.split(r'\n{2,}', text) if b.strip()]
pairs = []
for b in blocks:
    lines = [l.strip() for l in b.split('\n') if l.strip()]
    if len(lines) >= 2:
        pairs.append({'front': lines[1], 'back': lines[0]})

js_items = []
for i, p in enumerate(pairs):
    front = p['front'].replace('\\', '\\\\').replace("'", "\\'")
    back = p['back'].replace('\\', '\\\\').replace("'", "\\'")
    js_items.append("  {id:'v%d',type:'vocab',front:'%s',back:'%s'}" % (i, front, back))

out = 'const VOCAB_DATA = [\n' + ',\n'.join(js_items) + '\n];'
with open('vocab_data.js', 'w', encoding='utf-8') as f:
    f.write(out)
print('Written', len(pairs), 'entries to vocab_data.js')
