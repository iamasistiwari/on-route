import './index.css';
import { createRoot } from 'react-dom/client';
import { getBootstrap } from './vscode';
import { RequestView } from './views/RequestView';
import { OverviewView } from './views/OverviewView';
import { SidebarView } from './views/SidebarView';

let container = document.getElementById('root');
if (!container) {
  container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
}

const { view } = getBootstrap();
createRoot(container).render(view === 'overview' ? <OverviewView /> : view === 'sidebar' ? <SidebarView /> : <RequestView />);
