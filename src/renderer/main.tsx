import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import SimulateWorkspace from './components/SimulateWorkspace'
import './styles/global.css'

// TanStack Query is our transport layer over IPC: every main-process call is a
// query/mutation, giving caching, loading and refetch for free (ARCHITECTURE.md §1).
const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {new URLSearchParams(window.location.search).has('simulationControls')
        ? <SimulateWorkspace compact /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>
)
