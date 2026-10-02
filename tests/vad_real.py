"""Real Silero VAD: silence/noise rejection, short-pause merge and bounded long speech."""
import base64
import json
import os
from playwright.sync_api import sync_playwright
from reporting import ROOT, OUTPUT


def main():
    base = os.environ.get('SONORA_BASE_URL', 'http://localhost:1420')
    wav = base64.b64encode((ROOT / 'tests/fixtures/speech-en.wav').read_bytes()).decode()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(base)
        result = page.evaluate('''async ({wav}) => {
          const {createVadSession} = await import('/src/lib/vad.ts');
          const {wavSamples} = await import('/src/offline/catalog.ts');
          const input = wavSamples(Uint8Array.from(atob(wav), c => c.charCodeAt(0)));
          // Use a real VAD-bounded clip; energy trimming can retain breaths
          // that VAD rightly treats as additional silence between repeats.
          const bounded=[];
          const firstVad=await createVadSession(0.8,part=>{if(part.audio) bounded.push(part.audio);},error=>{throw new Error(error);},new AbortController().signal);
          for(let i=0;i<input.length;i+=1600) {
            firstVad.push(input.slice(i,i+1600),16000);
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          await firstVad.stop(true);
          if(bounded.length !== 1) throw new Error('Expected one reference utterance');
          const speech = wavSamples(bounded[0]);
          const silence = seconds => new Float32Array(Math.round(seconds*16000));
          const cases = [
            {name:'silence', parts:[silence(3)]},
            {name:'tone-not-speech', parts:[Float32Array.from({length:48000},(_,i)=>0.2*Math.sin(i*2*Math.PI*440/16000)),silence(1.2)]},
            {name:'one-utterance', parts:[speech,silence(1.2)]},
            {name:'short-pause-merge', parts:[speech,silence(0.3),speech,silence(1.2)]},
            {name:'long-continuation', parts:[speech,speech,speech,speech,speech,speech,silence(1.2)]},
            {name:'explicit-stop', parts:[speech]},
          ];
          const results=[];
          for (const test of cases) {
            const output=[], errors=[];
            const detector=await createVadSession(0.8, part=>output.push({id:part.id,final:part.final,seconds:part.audio?(part.audio.length-44)/32000:0}), error=>errors.push(error), new AbortController().signal);
            for (const samples of test.parts) for(let i=0;i<samples.length;i+=1600) {
              detector.push(samples.slice(i,i+1600),16000);
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            await detector.stop(true);
            results.push({name:test.name,output,errors});
          }
          return results;
        }''', {'wav': wav})
        browser.close()
    by_name = {case['name']: case for case in result}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    assert all(not case['errors'] for case in result), result
    assert by_name['silence']['output'] == []
    assert by_name['tone-not-speech']['output'] == []
    assert len(by_name['one-utterance']['output']) == 1
    merged = by_name['short-pause-merge']['output']
    assert len(merged) == 1 and merged[0]['final'] and merged[0]['seconds'] > 8, merged
    continuation = by_name['long-continuation']['output']
    assert any(not part['final'] for part in continuation), continuation
    assert continuation[-1]['final'] and len({part['id'] for part in continuation}) == 1, continuation
    assert all(part['seconds'] < 30 for part in continuation), continuation
    assert len(by_name['explicit-stop']['output']) == 1
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'vad-real.json').write_text(json.dumps({'passed': True, 'cases': result}, ensure_ascii=False, indent=2))
    print('PASS: real Silero VAD endpoints and continuation semantics.')


if __name__ == '__main__':
    main()
