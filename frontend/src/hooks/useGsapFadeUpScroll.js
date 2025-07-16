// src/hooks/useGsapFadeUpOnScroll.js
import {useEffect} from "react";
import {gsap} from "gsap";
import {ScrollTrigger} from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export const useGsapFadeUpOnScroll = (refs) => {
    useEffect(() => {
        refs.forEach((ref, index) => {
            if (ref.current) {
                gsap.fromTo(
                    ref.current,
                    {y: 50, opacity: 0},
                    {
                        y: 0,
                        opacity: 1,
                        duration: 1,
                        ease: "power3.out",
                        scrollTrigger: {
                            trigger: ref.current,
                            start: "top 80%",
                            toggleActions: "play none none none",
                        },
                    }
                );
            }
        });
    }, [refs]);
};