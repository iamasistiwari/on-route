import type { SidebarCommand, SidebarItemRef } from '../../shared/protocol';
import { post } from '../vscode';
import type { MenuItem } from './Menu';

const command = (name: SidebarCommand, item?: SidebarItemRef) => () => post({ type: 'runCommand', command: name, item });

/**
 * Pinning is sidebar-local state, so the sidebar passes a toggle in; views without pins (the overview)
 * leave it out and get no pin entry.
 */
export interface PinOption {
  pinned: boolean;
  toggle: () => void;
}

const pinItem = (pin: PinOption): MenuItem => ({
  label: pin.pinned ? 'Unpin' : 'Pin',
  icon: pin.pinned ? 'pinOff' : 'pin',
  separator: true,
  run: pin.toggle,
});

/** Menu for request rows ("⋯" button and right-click), shared by the sidebar and the overview. */
export function requestMenuItems(id: string, pin?: PinOption): MenuItem[] {
  const item: SidebarItemRef = { kind: 'request', id };
  return [
    { label: 'Duplicate', icon: 'copy', run: command('duplicateRequest', item) },
    { label: 'Copy as cURL', icon: 'terminal', run: command('copyAsCurl', item) },
    { label: 'Rename', icon: 'pencil', run: command('renameItem', item) },
    ...(pin ? [pinItem(pin)] : []),
    { label: 'Delete', icon: 'trash', danger: true, separator: true, run: command('deleteItem', item) },
  ];
}

/** Menu for folder rows. Delete asks for confirmation on the host side. */
export function folderMenuItems(id: string, pin?: PinOption): MenuItem[] {
  const item: SidebarItemRef = { kind: 'folder', id };
  return [
    { label: 'New Request', icon: 'plus', run: () => post({ type: 'newRequest', folderId: id }) },
    { label: 'New Folder', icon: 'newFolder', run: command('newFolder', item) },
    { label: 'Rename', icon: 'pencil', separator: true, run: command('renameItem', item) },
    ...(pin ? [pinItem(pin)] : []),
    { label: 'Delete', icon: 'trash', danger: true, separator: true, run: command('deleteItem', item) },
  ];
}

/** Right-click on empty space in the endpoint tree. */
export function rootMenuItems(): MenuItem[] {
  return [
    { label: 'New Request', icon: 'plus', run: () => post({ type: 'newRequest', folderId: '' }) },
    { label: 'New Folder', icon: 'newFolder', run: command('newFolder') },
    { label: 'Scan Project', icon: 'radar', separator: true, run: command('scanProject') },
  ];
}
