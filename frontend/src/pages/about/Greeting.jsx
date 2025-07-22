import React from 'react';
import './Greeting.css';
import {
    aboutGreetingImg1,
    aboutGreetingImg2,
    aboutGreetingImg3,
    aboutGreetingImg4,
    aboutGreetingImg5,
    aboutGreetingImg6
} from "../../assets/img/index.js";

const Greeting = () => {
    return (
        <div className="greeting-page">

            {/* 큰글씨 한 줄 */}
            <h1 className="greeting-large">“간판, 그 이상의 가치를 만듭니다.”</h1>

            {/* 중간글씨 한 줄 */}
            <h2 className="greeting-medium">에이치디사인의 철학과 다짐을 전합니다.</h2>

            {/* 작은 글씨 여러 줄 */}
            <div className="greeting-small-text">
                <p>안녕하세요. 에이치디사인 대표 홍길동입니다.</p>
                <p>저희는 단순히 간판을 제작하는 것이 아닌, 고객의 브랜드를 빛나게 하는 것이 사명이라 믿고 있습니다.</p>
                <p>다년간 축적된 기술력과 현장 경험을 바탕으로, 고객님의 비즈니스가 더 많은 사람들에게 다가갈 수 있도록 항상 최선을 다하겠습니다.</p>
            </div>

            {/* 제품 사진 흐르는 영역 */}
            <div className="greeting-product-marquee">
                <div className="marquee-content">
                    <img src={aboutGreetingImg1} alt="제품1"/>
                    <img src={aboutGreetingImg2} alt="제품2"/>
                    <img src={aboutGreetingImg3} alt="제품3"/>
                    <img src={aboutGreetingImg4} alt="제품4"/>
                    <img src={aboutGreetingImg5} alt="제품5"/>
                    <img src={aboutGreetingImg6} alt="제품6"/>

                    {/* 반복해서 더 넣어도 됨 */}
                </div>
            </div>

            {/* 밑에 작은 글씨 몇 줄 + 대표이사 이름 */}
            <div className="greeting-footer-text">
                <p>에이치디사인은 언제나 고객과 함께 성장하는 기업입니다.</p>
                <p>끊임없는 연구와 혁신으로 최고의 품질을 약속드립니다.</p>
                <p className="greeting-sign">에이치디사인 대표 홍길동 드림</p>
            </div>

        </div>
    );
};

export default Greeting;
