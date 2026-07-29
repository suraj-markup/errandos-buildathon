import { describe, expect, it } from 'vitest';
import { buildSanitizedSemanticCandidates } from './semantic-candidates';

function node(
  attributes: Record<string, string>,
  children = '',
): string {
  const serialized = Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return children
    ? `<node ${serialized}>${children}</node>`
    : `<node ${serialized} />`;
}

describe('sanitized semantic candidates', () => {
  it('returns opaque choices while keeping bounds and local node IDs private', () => {
    const source = `<hierarchy>${node({
      bounds: '[20,200][1060,360]',
      class: 'android.widget.Button',
      clickable: 'true',
      'content-desc': 'Add Amul Taaza',
      displayed: 'true',
      enabled: 'true',
      text: '',
    })}</hierarchy>`;
    const result = buildSanitizedSemanticCandidates(source, {
      refFactory: (index) => `opaque-${index}`,
    });

    expect(result.candidates).toEqual([{
      elementRef: 'opaque-0',
      label: 'Add Amul Taaza',
      role: 'button',
    }]);
    expect(JSON.stringify(result.candidates)).not.toMatch(
      /bounds|source-node|android\.widget|clickable|20|1060/,
    );
    expect(result.bindings.get('opaque-0')).toEqual({
      bounds: { x: 20, y: 200, width: 1040, height: 160 },
      localNodeId: 'source-node-0',
    });
  });

  it('labels duplicate controls with non-geometric occurrences', () => {
    const repeated = node({
      bounds: '[10,100][200,180]',
      class: 'android.widget.Button',
      clickable: 'true',
      displayed: 'true',
      enabled: 'true',
      text: 'Add',
    }) + node({
      bounds: '[10,200][200,280]',
      class: 'android.widget.Button',
      clickable: 'true',
      displayed: 'true',
      enabled: 'true',
      text: 'Add',
    });
    const result = buildSanitizedSemanticCandidates(`<hierarchy>${repeated}</hierarchy>`, {
      refFactory: (index) => `opaque-${index}`,
    });

    expect(result.candidates.map(({ occurrence }) => occurrence)).toEqual([1, 2]);
  });

  it('uses nested product variant text and selected state', () => {
    const variant = node({
      bounds: '[10,100][900,320]',
      class: 'android.view.ViewGroup',
      clickable: 'true',
      displayed: 'true',
      enabled: 'true',
      selected: 'true',
      text: '',
    }, node({
      bounds: '[20,120][600,180]',
      class: 'android.widget.TextView',
      clickable: 'false',
      displayed: 'true',
      enabled: 'true',
      text: 'Amul Taaza Toned Milk',
    }) + node({
      bounds: '[20,190][300,250]',
      class: 'android.widget.TextView',
      clickable: 'false',
      displayed: 'true',
      enabled: 'true',
      text: '500 ml · ₹29',
    }));
    const result = buildSanitizedSemanticCandidates(`<hierarchy>${variant}</hierarchy>`, {
      refFactory: (index) => `opaque-${index}`,
    });

    expect(result.candidates).toEqual([{
      elementRef: 'opaque-0',
      label: 'Amul Taaza Toned Milk · 500 ml · ₹29',
      role: 'button',
      selected: true,
    }]);
  });

  it('drops controls with no bounds, stale controls, and sensitive labels', () => {
    const source = `<hierarchy>${
      node({
        bounds: '',
        class: 'android.widget.Button',
        clickable: 'true',
        displayed: 'true',
        enabled: 'true',
        text: 'No bounds',
      })
    }${
      node({
        bounds: '[10,100][200,180]',
        class: 'android.widget.Button',
        clickable: 'true',
        displayed: 'false',
        enabled: 'true',
        text: 'Stale',
      })
    }${
      node({
        bounds: '[10,200][600,280]',
        class: 'android.widget.Button',
        clickable: 'true',
        displayed: 'true',
        enabled: 'true',
        text: 'Call +91 98765 43210',
      })
    }</hierarchy>`;

    expect(buildSanitizedSemanticCandidates(source).candidates).toEqual([]);
  });

  it('bounds output and excludes off-content controls', () => {
    const source = `<hierarchy>${node({
      bounds: '[0,0][100,50]',
      class: 'android.widget.Button',
      clickable: 'true',
      displayed: 'true',
      enabled: 'true',
      text: 'System status',
    })}${node({
      bounds: '[20,200][500,300]',
      class: 'android.widget.Button',
      clickable: 'true',
      displayed: 'true',
      enabled: 'true',
      text: 'Add milk',
    })}</hierarchy>`;
    const result = buildSanitizedSemanticCandidates(source, {
      contentRect: { x: 0, y: 100, width: 1080, height: 2200 },
      maxCandidates: 1,
      refFactory: (index) => `opaque-${index}`,
    });

    expect(result.candidates.map(({ label }) => label)).toEqual(['Add milk']);
  });
});
