import { describe, expect, it } from 'vitest';
import { defaultProjectConfig, type ProjectTree } from '../../shared/model';
import { nameConflict, uniqueName } from './treeUtils';

const tree: ProjectTree = {
  config: defaultProjectConfig('t'),
  folders: [
    { id: 'health', name: 'health', auth: { type: 'inherit' }, variables: [] },
    { id: 'health/v1', name: 'V1', auth: { type: 'inherit' }, variables: [] },
  ],
  requests: [
    { id: 'health/health-check', folderId: 'health', name: 'Health Check', method: 'GET', url: '/health' },
    { id: 'check/gst', folderId: 'check', name: 'gst-to-contact', method: 'POST', url: '/gst' },
  ],
  environments: [],
  errors: [],
};

describe('nameConflict', () => {
  it('rejects a request name used anywhere in the project, ignoring case and spaces', () => {
    expect(nameConflict(tree, 'request', '  health check ')).toMatch(/already exists/);
    expect(nameConflict(tree, 'request', 'GST-TO-CONTACT')).toMatch(/check\/gst/);
    expect(nameConflict(tree, 'request', 'other')).toBeUndefined();
  });

  it('checks folders separately, including folders synthesized from request paths', () => {
    expect(nameConflict(tree, 'folder', 'v1')).toMatch(/already exists/);
    expect(nameConflict(tree, 'folder', 'check')).toMatch(/already exists/);
    expect(nameConflict(tree, 'folder', 'Health Check')).toBeUndefined();
  });

  it('allows keeping the name of the item being renamed', () => {
    expect(nameConflict(tree, 'request', 'health check', 'health/health-check')).toBeUndefined();
    expect(nameConflict(tree, 'folder', 'HEALTH', 'health')).toBeUndefined();
  });
});

describe('uniqueName', () => {
  it('numbers the name until it is free', () => {
    expect(uniqueName(tree, 'request', 'New Request')).toBe('New Request');
    expect(uniqueName(tree, 'request', 'Health Check')).toBe('Health Check 2');
  });
});
