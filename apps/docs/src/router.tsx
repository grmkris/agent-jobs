import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { NotFound } from '@/components/not-found'
export function getRouter() { return createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true, defaultNotFoundComponent: NotFound }) }
