// Greeting.jsx
import React from 'react';
import Slider from "react-slick"; // 추가
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
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
    const settings = {
        dots: false,
        infinite: true,
        speed: 1000,
        slidesToShow: 3, // 한 화면에 보여줄 이미지 수
        slidesToScroll: 1,
        autoplay: true,
        autoplaySpeed: 2500,
        swipeToSlide: true,
        draggable: true,
    };

    return (
        <div className="greeting-page">

            {/* 큰글씨 한 줄 */}
            <h1 className="greeting-large">"최고의 품질, 에이치디사인의 약속입니다."</h1>

            {/* 중간글씨 한 줄 */}
            <h2 className="greeting-medium">최고의 품질과 내구성을 위해 끊임없이 연구하도록 노력하겠습니다.</h2>

            {/* 작은 글씨 여러 줄 */}
            <div className="greeting-small-text">
                <p>안녕하세요, 에이치디사인 대표 김길수 입니다.</p> <br/>
                <p>에이치디사인은 고객님의 사업에 꼭 맞는 간판을 만듭니다.<br/>
                    간판은 단순히 가게를 알리는 것을 넘어<br/>
                    고객님의 사업을 대표하는 첫인상이자 얼굴이 됩니다.<br/>
                    <br/>
                    그래서 저희는 겉보기만 좋은 간판이 아닌<br/>
                    시간이 지나도 변함없는 품질과 튼튼한 내구성을 가장 중요하게 생각합니다.</p><br/>
                <p> 이 약속을 지키기 위해 저희는 최고의 품질과 내구성을 위해<br/>
                    끊임없이 연구하도록 노력하겠습니다.<br/>
                    새로운 재료와 더 나은 제작 방식을 꾸준히 살피고 적용하며<br/>
                    모든 간판에 오랜 경험과 기술을 담습니다.</p>
                <br/>
                <br/>

            </div>

            {/* slick 슬라이더로 교체 */}
            <div className="greeting-slider">
                <Slider {...settings}>
                    <img src={aboutGreetingImg1} alt="제품1"/>
                    <img src={aboutGreetingImg2} alt="제품2"/>
                    <img src={aboutGreetingImg3} alt="제품3"/>
                    <img src={aboutGreetingImg4} alt="제품4"/>
                    <img src={aboutGreetingImg5} alt="제품5"/>
                    <img src={aboutGreetingImg6} alt="제품6"/>
                </Slider>
            </div>

            {/* 밑에 작은 글씨 몇 줄 + 대표이사 이름 */}
            <div className="greeting-footer-text">
                <p>에이치디사인의 간판이 고객님의 사업에 긍정적인 영향을 줄 수 있도록, <br/>
                    항상 믿을 수 있는 품질로 보답하겠습니다.</p>

                <p className="greeting-sign">
                    대표이사 <span className="ceo-name">김 길 수</span>
                </p>
            </div>
        </div>
    );
};

export default Greeting;
