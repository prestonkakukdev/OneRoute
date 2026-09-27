import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRightIcon, MenuIcon, XIcon } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { NAV, QUICK_START_URL } from '@/content';
import { cn } from '@/lib/utils';

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-wordmark text-[19px] leading-none font-medium tracking-[-0.03em]', className)}>OneRoute</span>;
}

export function Nav() {
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const links = NAV.map((l) => (
    <a
      key={l.label}
      href={l.href}
      onClick={() => setOpen(false)}
      {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[14px] transition-colors duration-150"
    >
      {l.label}
      {l.external ? <ArrowUpRightIcon className="size-3.5 opacity-60" aria-hidden /> : null}
    </a>
  ));

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300',
        scrolled || open ? 'border-b bg-background/75 backdrop-blur-xl' : 'border-b border-transparent',
      )}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6" aria-label="Main">
        <a href="#top" aria-label="OneRoute home">
          <Wordmark />
        </a>
        <div className="hidden items-center gap-7 md:flex">{links}</div>
        <div className="flex-1" />
        <Button asChild size="sm" className="hidden rounded-full px-4 md:inline-flex">
          <a href={QUICK_START_URL} target="_blank" rel="noopener noreferrer">
            Get started
          </a>
        </Button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground -mr-2 flex size-10 items-center justify-center rounded-xl md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <XIcon className="size-5" aria-hidden /> : <MenuIcon className="size-5" aria-hidden />}
        </button>
      </nav>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden md:hidden"
          >
            <div className="flex flex-col gap-4 px-6 pt-1 pb-6">
              {links}
              <Button asChild className="mt-2 rounded-full">
                <a href={QUICK_START_URL} target="_blank" rel="noopener noreferrer">
                  Get started
                </a>
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
