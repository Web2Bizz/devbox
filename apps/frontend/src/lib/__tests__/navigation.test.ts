import { describe, expect, test } from 'bun:test';
import {
  isLegacyProjectPath,
  orgPath,
  orgProjectsPath,
  projectAiPath,
  projectNavItems,
  projectPath,
  projectSecretsPath,
  projectSessionPath,
} from '../navigation';

describe('nested navigation', () => {
  test('org/project paths nest', () => {
    expect(orgPath('o1')).toBe('/organizations/o1');
    expect(orgProjectsPath('o1')).toBe('/organizations/o1/projects');
    expect(projectPath('o1', 'p1')).toBe('/organizations/o1/projects/p1');
    expect(projectSessionPath('o1', 'p1', 's1')).toBe(
      '/organizations/o1/projects/p1/sessions/s1',
    );
  });

  test('scoped surfaces hang under project', () => {
    expect(projectSecretsPath('o1', 'p1')).toBe('/organizations/o1/projects/p1/secrets');
    expect(projectAiPath('o1', 'p1')).toBe('/organizations/o1/projects/p1/ai-providers');
  });

  test('project nav items stay project-scoped', () => {
    const items = projectNavItems('o1', 'p1');
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.href.startsWith('/organizations/o1/projects/p1')).toBe(true);
    }
  });

  test('legacy detector never guesses an org', () => {
    expect(isLegacyProjectPath('/projects')).toBe(true);
    expect(isLegacyProjectPath('/projects/abc')).toBe(true);
    expect(isLegacyProjectPath('/organizations/o1')).toBe(false);
  });
});
