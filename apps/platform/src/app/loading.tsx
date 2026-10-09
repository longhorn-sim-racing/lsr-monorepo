import Image from "next/image"

export default function Loading() {
  return (
    <div role="status" className="flex w-full min-h-[60vh] flex-col items-center justify-center">
      <span className="sr-only">Loading</span>
      <div className="relative h-64 w-64 md:h-96 md:w-96">
        {/* Base dimmed logo */}
        <Image
          src="/brand/logos/white_logo2.png"
          alt=""
          fill
          className="object-contain opacity-20"
          priority
          fetchPriority="high"
        />
        
        {/* Shimmer overlay masked to logo */}
        <div 
          className="absolute inset-0 z-10"
          style={{
            maskImage: "url('/brand/logos/white_logo2.png')",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskImage: "url('/brand/logos/white_logo2.png')",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
          }}
        >
          <div className="h-full w-full animate-[shimmer_4s_linear_infinite] bg-gradient-to-r from-transparent via-white to-transparent" />
        </div>
      </div>
    </div>
  )
}
