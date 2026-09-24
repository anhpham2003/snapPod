import { ArrowRight, Captions, Scissors, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "~/components/ui/button";

const steps = [
  {
    icon: Sparkles,
    title: "Find the moments",
    text: "SnapPod transcribes your conversation and ranks its strongest self-contained moments.",
  },
  {
    icon: Scissors,
    title: "Create short clips",
    text: "Active-speaker framing turns the best moments into vertical, social-ready videos.",
  },
  {
    icon: Captions,
    title: "Finish with captions",
    text: "Synchronized captions are added automatically before your clips are ready to download.",
  },
];

export default function HomePage() {
  return (
    <main className="bg-background min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="text-xl font-semibold tracking-tight">
            SnapPod
          </Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/signup">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <p className="bg-muted mb-6 rounded-full px-4 py-1.5 text-sm font-medium">
          From long conversation to short-form video
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold tracking-tight sm:text-7xl">
          Find the moments worth sharing.
        </h1>
        <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-8">
          Upload a podcast or interview and let SnapPod identify key moments,
          follow the active speaker, add captions, and create vertical clips.
        </p>
        <Button size="lg" className="mt-8" asChild>
          <Link href="/signup">
            Create your first clips <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </section>

      <section className="border-t">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-20 md:grid-cols-3">
          {steps.map(({ icon: Icon, title, text }) => (
            <article key={title} className="rounded-xl border p-6">
              <Icon className="mb-5 h-6 w-6" />
              <h2 className="font-semibold">{title}</h2>
              <p className="text-muted-foreground mt-2 text-sm leading-6">
                {text}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
