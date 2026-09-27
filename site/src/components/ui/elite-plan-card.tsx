"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface ElitePlanCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** OneRoute: optional; without it the card is text only. */
  imageUrl?: string;
  title: string;
  subtitle: string;
  description: string;
  highlights?: string[]; // new section for extra text
  onAction?: () => void;
  /** OneRoute addition: label for the action button (defaults to "Learn More"). */
  actionLabel?: string;
  /** OneRoute addition: "horizontal" puts the text beside the action (defaults to "vertical"). */
  orientation?: "vertical" | "horizontal";
  /** OneRoute addition: grow on hover (defaults to true). */
  interactive?: boolean;
}

export const ElitePlanCard = React.forwardRef<
  HTMLDivElement,
  ElitePlanCardProps
>(
  (
    {
      className,
      imageUrl,
      title,
      subtitle,
      description,
      highlights = [],
      onAction,
      actionLabel = "Learn More",
      orientation = "vertical",
      interactive = true,
      ...props
    },
    ref
  ) => {
    const horizontal = orientation === "horizontal";
    return (
      <motion.div
        ref={ref}
        whileHover={interactive ? { scale: 1.02 } : undefined}
        transition={{ type: "spring", stiffness: 250, damping: 20 }}
        className={cn(
          "relative w-full overflow-hidden rounded-3xl bg-black",
          horizontal ? "max-w-none" : "max-w-sm",
          interactive && "hover:shadow-xl",
          className
        )}
        {...(props as React.ComponentProps<typeof motion.div>)}
      >
        {/* Top image with parallax */}
        {imageUrl ? (
          <motion.div
            className="relative h-64 w-full overflow-hidden"
            whileHover={interactive ? { scale: 1.1 } : undefined}
            transition={{ duration: 0.45 }}
          >
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover"
            />
            {/* Fade connection between image and black background */}
            <div className="absolute bottom-0 h-32 w-full bg-gradient-to-t from-black via-black/80 to-transparent" />
          </motion.div>
        ) : null}

        {/* Bottom content */}
        <div
          className={cn(
            "relative z-10 p-6 bg-black text-white",
            horizontal && "grid grid-cols-[1fr_auto] items-center gap-x-10 p-8 max-md:grid-cols-1 max-md:gap-y-6"
          )}
        >
          <div>
          <p className="text-sm uppercase tracking-wider text-gray-400">
            {subtitle}
          </p>
          <h3 className="mt-1 text-2xl font-bold">{title}</h3>
          <p className="mt-3 text-sm leading-relaxed text-gray-300">
            {description}
          </p>

          {/* Highlights */}
          {highlights.length > 0 && (
            <ul className={cn("mt-4 grid grid-cols-2 gap-2 text-xs text-gray-400", horizontal && "max-w-xl grid-cols-4 max-lg:grid-cols-2")}>
              {highlights.map((item, idx) => (
                <li
                  key={idx}
                  className="flex items-center gap-2 rounded-md bg-gray-800/50 px-2 py-1"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  {item}
                </li>
              ))}
            </ul>
          )}

          </div>

          {/* CTA */}
          {onAction && (
            <div className={cn(!horizontal && "mt-6")}>
              <Button
                variant="default"
                onClick={onAction}
                className={cn("w-full bg-white text-black hover:bg-gray-200", horizontal && "min-w-44 rounded-full")}
              >
                {actionLabel}
              </Button>
            </div>
          )}
        </div>
      </motion.div>
    );
  }
);

ElitePlanCard.displayName = "ElitePlanCard";
