import { create } from 'zustand'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'benchmark'

interface UIState {
  currentView: View
  sidebarOpen: boolean
  setView: (view: View) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()((set) => ({
  currentView: 'chat',
  sidebarOpen: true,

  // Sidebar visibility follows the view: it's the conversation list, which
  // only makes sense in Chat. The hamburger toggle still works on other views;
  // it just resets to the view's default on the next setView() call.
  setView: (view) => set({ currentView: view, sidebarOpen: view === 'chat' }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}))
