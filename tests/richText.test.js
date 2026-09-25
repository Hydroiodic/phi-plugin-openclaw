import assert from 'node:assert/strict'
import test from 'node:test'
import fCompute from '../model/game/fCompute.js'

test('convertRichText renders Unity tags and line breaks', () => {
    assert.equal(
        fCompute.convertRichText('<color=#ff0000>红</color><b>粗</b>\n<i>斜</i><size=30>大</size>'),
        '<span style="color:#ff0000">红</span><b>粗</b><br><i>斜</i>大',
    )
})

test('convertRichText escapes markup and rejects CSS injection in colors', () => {
    assert.equal(fCompute.convertRichText('a<b & c'), 'a&lt;b &amp; c')
    assert.equal(
        fCompute.convertRichText('<color=red;background:url(http://x)>x</color>'),
        '<span style="color:inherit">x</span>',
    )
})

test('convertRichText can return plain text', () => {
    assert.equal(fCompute.convertRichText('<color="blue"><b>a<b</b></color>\nx', true), 'a<b\nx')
})
