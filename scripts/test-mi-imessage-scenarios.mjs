#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  imessageDetectCandidatesQuery,
  imessageIsBareUrl,
  imessageLooksLikePriorWorkStatusQuestion,
  imessageNormalizeDisplayText,
  imessagePriorWorkStatusReply,
  imessageWorkDecision,
} from './mi-imessage-routing.mjs';

const ts = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const user = (text, n = 1) => ({ role: 'user', source: 'imessage', text, ts: ts(n) });
const assistant = (text, source, n = 1) => ({ role: 'assistant', source, text, ts: ts(n) });
const decide = (message, history = [], options = {}) => imessageWorkDecision(message, history, options);

assert.equal(imessageIsBareUrl('https://example.com/a'), true, 'bare URL is detected');
assert.equal(decide('https://example.com/a').action, 'chat', 'bare URL alone stays chat');
assert.equal(decide('Any new detect candidates?').action, 'fetch', 'detect candidate questions fetch live active candidates');
assert.equal(decide('list the detect canidates').action, 'fetch', 'detect candidate list typo fetches live active candidates');
assert.equal(decide('what are the detect canidtaes').action, 'fetch', 'detect candidate question typo fetches live active candidates');
assert.equal(imessageDetectCandidatesQuery('approve candidate #123'), false, 'candidate mutations do not route to fetch');
assert.equal(decide('check detect status').action, 'start', 'clear status checks start work');
assert.equal(decide('run detect').action, 'ask', 'pipeline run asks for confirmation');
assert.equal(decide('run ingest').action, 'ask', 'ingest asks for confirmation');
assert.equal(decide('run report').action, 'ask', 'report asks for confirmation');
assert.equal(decide('rescore pending candidates').action, 'ask', 'rescore asks for confirmation');
assert.equal(decide('approve candidate #123').action, 'ask', 'candidate approval asks for confirmation');
assert.equal(decide('reject candidate #123').action, 'ask', 'candidate rejection asks for confirmation');
assert.equal(decide('edit report #123').action, 'ask', 'report edits ask for confirmation');
assert.equal(decide('restart cron').action, 'ask', 'cron restart asks for confirmation');
assert.equal(decide('are crons working?').action, 'chat', 'cron question stays chat');
assert.equal(decide('yes').action, 'chat', 'no-context yes stays chat');
assert.equal(decide('go ahead and run detect').action, 'start', 'explicit go-ahead starts work');

const confirmAssistantOffer = decide('yes', [
  user('No, for the research pipeline', 1),
  assistant('Got it, you mean the actual Tactics Journal research pipeline candidates, not just chat links. I can check the current list for you if you want.', 'imessage-chat', 2),
]);
assert.equal(confirmAssistantOffer.action, 'start', 'confirmation accepts a recent assistant work offer');
assert.match(confirmAssistantOffer.targetMessage, /Tactics Journal research pipeline candidates list/, 'assistant offer becomes concrete work');

const sameMessage = decide('add this as a detect candidate https://example.com/story');
assert.equal(sameMessage.action, 'start', 'clear directive plus URL starts work');
assert.match(sameMessage.targetMessage, /https:\/\/example\.com\/story/, 'same-message URL is preserved');

const directiveThenUrl = decide('https://example.com/story', [user('add this as a detect candidate'), assistant('Want me to do that now?', 'imessage-confirm')]);
assert.equal(directiveThenUrl.action, 'ask', 'URL after pending directive confirms before work');
assert.match(directiveThenUrl.targetMessage, /add this as a detect candidate[\s\S]*https:\/\/example\.com\/story/, 'URL is attached to pending directive');

const confirmAfterUrl = decide('yes', [
  user('add this as a detect candidate', 1),
  assistant('Want me to do that now?', 'imessage-confirm', 2),
  user('https://example.com/story', 3),
  assistant('Want me to do that now?', 'imessage-confirm', 4),
]);
assert.equal(confirmAfterUrl.action, 'start', 'confirmation after URL starts pending work');
assert.match(confirmAfterUrl.targetMessage, /add this as a detect candidate[\s\S]*https:\/\/example\.com\/story/, 'confirmation uses original directive plus URL');

const urlThenDirective = decide('add this as a detect candidate', [user('https://example.com/first')]);
assert.equal(urlThenDirective.action, 'start', 'clear directive after orphan URL starts work');
assert.match(urlThenDirective.targetMessage, /https:\/\/example\.com\/first/, 'directive adopts recent orphan URL');

const askFirst = decide('add this as a detect candidate https://example.com/story', [], { askFirst: true });
assert.equal(askFirst.action, 'ask', 'ask-first still asks');

assert.equal(imessageLooksLikePriorWorkStatusQuestion('did you add it?'), true, 'did-you status question detected');
assert.equal(imessagePriorWorkStatusReply([assistant('On it. I’ll follow up here.', 'imessage-work-ack')], 'did you add it?'), 'Not yet, I’m still on it and will follow up here.');
assert.match(imessagePriorWorkStatusReply([assistant('Candidate #123 is pending for https://example.com/story', 'mi-worker-result')], 'did you add it?'), /Candidate #123/, 'status uses worker result text');
assert.equal(imessagePriorWorkStatusReply([], 'why is it pending?'), 'Pending means it is saved for review and report consideration. It does not mean the request failed.');

const formattedBrief = imessageNormalizeDisplayText('Good morning, Kyle.\n\nWeather:\n  • 72° and clear\n\nFootball:\n  • Key match or news');
assert.equal(formattedBrief, 'Good morning, Kyle.\n\nWeather:\n • 72° and clear\n\nFootball:\n • Key match or news', 'iMessage display cleanup preserves real line breaks and blank lines');
assert.equal(imessageNormalizeDisplayText('Weather:  sunny   later'), 'Weather: sunny later', 'iMessage display cleanup still compacts repeated inline spaces');

console.log('mi iMessage scenario tests passed');
