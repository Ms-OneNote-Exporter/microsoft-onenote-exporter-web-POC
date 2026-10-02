import { describe, expect, it } from 'vitest';
import { LineReader, stripAnsi } from '../src/line-reader';

describe('stripAnsi', () => {
  it('removes chalk colour sequences', () => {
    expect(stripAnsi('\u001b[90m[Oct 02 20:39:57]\u001b[39m \u001b[34m[INFO]\u001b[39m hi')).toBe(
      '[Oct 02 20:39:57] [INFO] hi',
    );
  });

  it('leaves text without codes untouched', () => {
    expect(stripAnsi('[INFO] plain')).toBe('[INFO] plain');
  });
});

describe('LineReader', () => {
  it('emits a complete line and holds nothing back', () => {
    const reader = new LineReader();
    expect(reader.push('hello\n')).toEqual(['hello']);
    expect(reader.tail()).toBe('');
  });

  it('joins a line split across two chunks', () => {
    const reader = new LineReader();
    expect(reader.push('[Oct 02 20:39:57] [INF')).toEqual([]);
    expect(reader.push('O] Exporting: A\n')).toEqual(['[Oct 02 20:39:57] [INFO] Exporting: A']);
  });

  it('emits several lines from one chunk', () => {
    const reader = new LineReader();
    expect(reader.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('keeps an unterminated tail out of the line list', () => {
    const reader = new LineReader();
    expect(reader.push('Enter the verification code: ')).toEqual([]);
    expect(reader.tail()).toBe('Enter the verification code: ');
  });

  it('strips CRLF line endings', () => {
    const reader = new LineReader();
    expect(reader.push('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('strips ANSI from a split line, at any chunk boundary', () => {
    const reader = new LineReader();
    reader.push('\u001b[3');
    expect(reader.push('4m[INFO]\u001b[39m done\n')).toEqual(['[INFO] done']);
  });

  describe('takeUnpublishedTail', () => {
    it('returns the MFA prompt that readline wrote without a newline', () => {
      // This is the case the whole MFA flow depends on. `rl.question()` writes
      // its prompt and then blocks on stdin; there is no newline coming until
      // the user answers, so a reader that only emits newline-terminated lines
      // would never surface the challenge.
      const reader = new LineReader();
      reader.push('Enter the verification code: ');
      expect(reader.takeUnpublishedTail()).toBe('Enter the verification code: ');
    });

    it('returns null the second time, so a prompt is not emitted twice', () => {
      const reader = new LineReader();
      reader.push('Enter the verification code: ');
      expect(reader.takeUnpublishedTail()).toBe('Enter the verification code: ');
      expect(reader.takeUnpublishedTail()).toBeNull();
    });

    it('returns only the newly arrived part when the tail grows', () => {
      const reader = new LineReader();
      reader.push('Enter the code');
      expect(reader.takeUnpublishedTail()).toBe('Enter the code');
      reader.push(': ');
      expect(reader.takeUnpublishedTail()).toBe(': ');
    });

    it('is null when nothing is pending', () => {
      expect(new LineReader().takeUnpublishedTail()).toBeNull();
    });

    it('resets once the line completes, so the full line arrives once', () => {
      const reader = new LineReader();
      reader.push('Enter the verification code: ');
      reader.takeUnpublishedTail();
      // The answer arrives; readline echoes a newline and the line completes.
      expect(reader.push('\n')).toEqual(['Enter the verification code: ']);
      expect(reader.takeUnpublishedTail()).toBeNull();
    });
  });

  describe('flush', () => {
    it('returns a last line that never got its newline', () => {
      const reader = new LineReader();
      reader.push('no trailing newline');
      expect(reader.flush()).toBe('no trailing newline');
    });

    it('is empty after the line completed normally', () => {
      const reader = new LineReader();
      reader.push('done\n');
      expect(reader.flush()).toBe('');
    });
  });
});