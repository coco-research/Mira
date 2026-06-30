import { describe, it, expect } from 'vitest'
import { detectChatToolCapability, detectChatToolIntent, CHAT_TOOLS } from '../chat-tool-intent'

describe('detectChatToolCapability', () => {
  it('exposes exactly the five curated tools', () => {
    expect([...CHAT_TOOLS].sort()).toEqual(
      ['file_write', 'image_generate', 'video_generate', 'web_fetch', 'web_search'].sort(),
    )
  })

  describe('image', () => {
    for (const p of [
      'draw me a picture of a red apple',
      'generate an image of a sunset over mountains',
      'make a logo for my coffee shop',
      'mal mir ein bild von einem hund',
      'erstelle eine grafik mit einem berg',
      'zeichne ein porträt einer katze',
    ]) {
      it(`image: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('image'))
    }
  })

  describe('video', () => {
    for (const p of [
      'make a short video of waves at the beach',
      'generate a clip of a flying bird',
      'animate this image into a video',
      'erstelle ein video von einem wasserfall',
      'animier das bild',
    ]) {
      it(`video: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('video'))
    }

    it('prefers video when both a video and image noun appear', () => {
      expect(detectChatToolCapability('turn this picture into a short video')).toBe('video')
    })

    it('routes "animate" with an attached image to video', () => {
      expect(detectChatToolCapability('animate this', true)).toBe('video')
    })
  })

  describe('web', () => {
    for (const p of [
      'search the web for the latest python version',
      'google who won the champions league final',
      'look up the current bitcoin price',
      'what is the weather in Berlin right now',
      'such im web nach den neuesten nvidia treibern',
      'recherchiere die aktuellen news zu KI',
      'summarize this page https://example.com/post',
      'open https://news.ycombinator.com and tell me the top story',
    ]) {
      it(`web: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('web'))
    }
  })

  describe('file', () => {
    for (const p of [
      'write a file called notes.txt with my todo list',
      'save this to a file',
      'create a hello.html with a heading',
      'schreib eine datei mit dem text hallo',
      'speicher das als output.json',
      'export the result to a csv file',
    ]) {
      it(`file: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('file'))
    }
  })

  describe('plain conversation must NOT route (no false positives)', () => {
    for (const p of [
      'hi there',
      'how are you today?',
      'explain how recursion works',
      'what is the capital of France',
      'tell me a joke',
      'can you help me understand quantum entanglement',
      'i like the picture you described earlier', // mentions "picture" but no create verb
      'thanks, that was helpful',
      'write a haiku about autumn', // "write" but no file noun/extension
      'make it shorter please',
      'what do you think about this idea',
      'summarize the conversation so far', // no page/url noun
    ]) {
      it(`plain: "${p}"`, () => expect(detectChatToolCapability(p)).toBeNull())
    }
  })

  it('detectChatToolIntent is the boolean wrapper', () => {
    expect(detectChatToolIntent('draw a cat')).toBe(true)
    expect(detectChatToolIntent('hello')).toBe(false)
    expect(detectChatToolIntent('')).toBe(false)
  })
})
