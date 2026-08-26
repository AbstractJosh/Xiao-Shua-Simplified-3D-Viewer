import { Console } from './console/Console'
import { NavBar } from './console/NavBar'
import { Viewport } from './viewport/Viewport'

/**
 * Two halves, split by what they are about. The bar across the top holds the
 * tools -- how you work, and what leaves the app. The console on the right holds
 * the document: what you can drop in, what is selected, and what the scene now
 * contains. Nothing appears in both.
 */
export default function App() {
  return (
    <div className="app">
      <NavBar />

      <main className="main">
        <Viewport />
        <Console />
      </main>
    </div>
  )
}
