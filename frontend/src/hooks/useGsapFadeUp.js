// src/hooks/useGsapFadeUp.js
import {useEffect} from "react";
import {gsap} from "gsap";

export const useGsapFadeUp = (refs) => {
    useEffect(() => {
        const tl = gsap.timeline();

        refs.forEach((ref, index) => {
            tl.from(ref.current, {
                y: 50 - index * 10,
                opacity: 0,
                duration: 1,
                ease: "power3.out"
            }, index === 0 ? 0 : `-=${0.5 - index * 0.1}`);
        });
    }, [refs]);
};

