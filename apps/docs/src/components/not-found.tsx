export function NotFound() {
  return (
    <main className="mx-auto flex min-h-[75vh] w-full max-w-2xl flex-col justify-center px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">Sidequest / documentation</p>
      <div className="mt-8 border-l-2 border-fd-primary pl-6">
        <p className="font-mono text-sm text-fd-primary">404</p>
        <h1 className="mt-3 max-w-lg text-4xl font-semibold tracking-tight sm:text-5xl">That page is off the board.</h1>
        <p className="mt-5 max-w-md leading-relaxed text-fd-muted-foreground">
          The link may be out of date. Start at the documentation to find the page you need.
        </p>
      </div>
      <div className="mt-8 flex flex-wrap gap-6 pl-6 text-sm">
        <a className="font-medium text-fd-primary underline underline-offset-4" href="/docs">
          Return to the docs
        </a>
        <a className="text-fd-muted-foreground hover:text-fd-foreground" href="/">
          Open Sidequest
        </a>
      </div>
    </main>
  )
}
