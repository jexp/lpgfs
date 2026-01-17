/**
 * Tests for LPGFS Path Parser
 */

import { describe, it, expect } from 'vitest';
import {
  parsePath,
  extractTargetFromRelPropertiesFilename,
  CONFIG_FILENAME,
  PROPERTIES_FILENAME,
  pathContextToCacheKey,
} from './path-parser.js';

describe('parsePath', () => {
  describe('root path', () => {
    it('should parse "/" as root', () => {
      expect(parsePath('/')).toEqual({ type: 'root' });
    });

    it('should parse empty string as root', () => {
      expect(parsePath('')).toEqual({ type: 'root' });
    });

    it('should handle trailing slashes', () => {
      expect(parsePath('//')).toEqual({ type: 'root' });
    });
  });

  describe('config file', () => {
    it('should parse /.lpgfs.yaml as config file', () => {
      expect(parsePath('/.lpgfs.yaml')).toEqual({
        type: 'properties',
        isConfigFile: true,
      });
    });
  });

  describe('label paths', () => {
    it('should parse /Person as label', () => {
      expect(parsePath('/Person')).toEqual({
        type: 'label',
        label: 'Person',
      });
    });

    it('should parse /Company as label', () => {
      expect(parsePath('/Company')).toEqual({
        type: 'label',
        label: 'Company',
      });
    });

    it('should handle trailing slash', () => {
      expect(parsePath('/Person/')).toEqual({
        type: 'label',
        label: 'Person',
      });
    });
  });

  describe('node paths', () => {
    it('should parse /Person/alice as node', () => {
      expect(parsePath('/Person/alice')).toEqual({
        type: 'node',
        label: 'Person',
        nodeName: 'alice',
      });
    });

    it('should parse /Company/acme as node', () => {
      expect(parsePath('/Company/acme')).toEqual({
        type: 'node',
        label: 'Company',
        nodeName: 'acme',
      });
    });

    it('should handle node names with underscores', () => {
      expect(parsePath('/Person/alice_smith')).toEqual({
        type: 'node',
        label: 'Person',
        nodeName: 'alice_smith',
      });
    });

    it('should handle elementId-style node names', () => {
      expect(parsePath('/Person/4_abc_0')).toEqual({
        type: 'node',
        label: 'Person',
        nodeName: '4_abc_0',
      });
    });
  });

  describe('node properties paths', () => {
    it('should parse /Person/alice/.properties.json as node properties', () => {
      expect(parsePath('/Person/alice/.properties.json')).toEqual({
        type: 'properties',
        label: 'Person',
        nodeName: 'alice',
        isPropertiesFile: true,
      });
    });
  });

  describe('relationship type paths', () => {
    it('should parse /Person/alice/KNOWS as reltype', () => {
      expect(parsePath('/Person/alice/KNOWS')).toEqual({
        type: 'reltype',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
      });
    });

    it('should parse /Person/alice/WORKS_AT as reltype', () => {
      expect(parsePath('/Person/alice/WORKS_AT')).toEqual({
        type: 'reltype',
        label: 'Person',
        nodeName: 'alice',
        relType: 'WORKS_AT',
      });
    });
  });

  describe('direction paths', () => {
    it('should parse /Person/alice/KNOWS/OUT as direction', () => {
      expect(parsePath('/Person/alice/KNOWS/OUT')).toEqual({
        type: 'direction',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'OUT',
      });
    });

    it('should parse /Person/alice/KNOWS/IN as direction', () => {
      expect(parsePath('/Person/alice/KNOWS/IN')).toEqual({
        type: 'direction',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'IN',
      });
    });
  });

  describe('target paths', () => {
    it('should parse /Person/alice/KNOWS/OUT/james as target', () => {
      expect(parsePath('/Person/alice/KNOWS/OUT/james')).toEqual({
        type: 'target',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'OUT',
        targetName: 'james',
      });
    });

    it('should parse /Person/alice/KNOWS/IN/bob as target', () => {
      expect(parsePath('/Person/alice/KNOWS/IN/bob')).toEqual({
        type: 'target',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'IN',
        targetName: 'bob',
      });
    });
  });

  describe('relationship properties paths', () => {
    it('should parse /Person/alice/KNOWS/OUT/.james.json as rel properties', () => {
      expect(parsePath('/Person/alice/KNOWS/OUT/.james.json')).toEqual({
        type: 'properties',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'OUT',
        targetName: 'james',
        isRelPropertiesFile: true,
      });
    });

    it('should parse /Person/alice/KNOWS/IN/.bob.json as rel properties', () => {
      expect(parsePath('/Person/alice/KNOWS/IN/.bob.json')).toEqual({
        type: 'properties',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'IN',
        targetName: 'bob',
        isRelPropertiesFile: true,
      });
    });
  });

  describe('cross-label relationship paths', () => {
    it('should parse /Person/alice/WORKS_AT/OUT/acme as target', () => {
      expect(parsePath('/Person/alice/WORKS_AT/OUT/acme')).toEqual({
        type: 'target',
        label: 'Person',
        nodeName: 'alice',
        relType: 'WORKS_AT',
        direction: 'OUT',
        targetName: 'acme',
      });
    });
  });

  describe('deep paths (symlink traversal)', () => {
    it('should handle paths beyond target with .properties.json', () => {
      const result = parsePath(
        '/Person/alice/KNOWS/OUT/james/.properties.json'
      );
      expect(result).toEqual({
        type: 'properties',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'OUT',
        targetName: 'james',
        isPropertiesFile: true,
      });
    });
  });

  describe('edge cases', () => {
    it('should handle multiple trailing slashes', () => {
      expect(parsePath('/Person///')).toEqual({
        type: 'label',
        label: 'Person',
      });
    });

    it('should handle self-referential relationship target', () => {
      expect(parsePath('/Person/alice/MANAGES/OUT/alice')).toEqual({
        type: 'target',
        label: 'Person',
        nodeName: 'alice',
        relType: 'MANAGES',
        direction: 'OUT',
        targetName: 'alice',
      });
    });

    it('should handle multiple relationships suffix pattern', () => {
      expect(parsePath('/Account/checking/TRANSFERRED/OUT/savings_1')).toEqual({
        type: 'target',
        label: 'Account',
        nodeName: 'checking',
        relType: 'TRANSFERRED',
        direction: 'OUT',
        targetName: 'savings_1',
      });
    });
  });
});

describe('extractTargetFromRelPropertiesFilename', () => {
  it('should extract target name from .james.json', () => {
    expect(extractTargetFromRelPropertiesFilename('.james.json')).toBe('james');
  });

  it('should extract target name from .bob.json', () => {
    expect(extractTargetFromRelPropertiesFilename('.bob.json')).toBe('bob');
  });

  it('should extract target name from .alice_1.json', () => {
    expect(extractTargetFromRelPropertiesFilename('.alice_1.json')).toBe(
      'alice_1'
    );
  });

  it('should return null for .properties.json', () => {
    expect(extractTargetFromRelPropertiesFilename('.properties.json')).toBe(
      null
    );
  });

  it('should return null for non-hidden files', () => {
    expect(extractTargetFromRelPropertiesFilename('james.json')).toBe(null);
  });

  it('should return null for non-json files', () => {
    expect(extractTargetFromRelPropertiesFilename('.james.txt')).toBe(null);
  });
});

describe('pathContextToCacheKey', () => {
  it('should generate key for root', () => {
    expect(pathContextToCacheKey({ type: 'root' })).toBe('root');
  });

  it('should generate key for label', () => {
    expect(pathContextToCacheKey({ type: 'label', label: 'Person' })).toBe(
      'label:Person'
    );
  });

  it('should generate key for node', () => {
    expect(
      pathContextToCacheKey({ type: 'node', label: 'Person', nodeName: 'alice' })
    ).toBe('node:Person:alice');
  });

  it('should generate key for full target path', () => {
    expect(
      pathContextToCacheKey({
        type: 'target',
        label: 'Person',
        nodeName: 'alice',
        relType: 'KNOWS',
        direction: 'OUT',
        targetName: 'james',
      })
    ).toBe('target:Person:alice:KNOWS:OUT:james');
  });
});

describe('constants', () => {
  it('CONFIG_FILENAME should be .lpgfs.yaml', () => {
    expect(CONFIG_FILENAME).toBe('.lpgfs.yaml');
  });

  it('PROPERTIES_FILENAME should be .properties.json', () => {
    expect(PROPERTIES_FILENAME).toBe('.properties.json');
  });
});
