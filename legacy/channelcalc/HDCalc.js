// 한 영 탭 로직
function toggleLangTabs() {
  const typeSelect = document.getElementById('type');
  const langDiv = document.getElementById('langOptionDiv');
  const val = typeSelect.value;

  // 한영 구분이 필요한 번호들: 3, 4, 6, 8, 9, 10
  const langTargets = ['3', '4', '6', '8', '9', '10'];

  if (langTargets.includes(val)) {
    langDiv.style.display = 'flex'; // 대상이면 보여줌
  } else {
    langDiv.style.display = 'none'; // 아니면 숨김
    document.getElementById('selectedLang').value = 'eng'; // 숨길 때 기본값 초기화
  }

  // 만약 LED 개수 계산 함수가 따로 있다면 여기서 호출
  // if (typeof ledCount === "function") ledCount();
}

// 2. 버튼 클릭 시 스타일 바꾸고 값을 저장하는 함수
function setLang(lang) {
  document.getElementById('selectedLang').value = lang;

  const btnEng = document.getElementById('btnEng');
  const btnKor = document.getElementById('btnKor');

  if (lang === 'eng') {
    btnEng.classList.add('active');
    btnKor.classList.remove('active');
  } else {
    btnKor.classList.add('active');
    btnEng.classList.remove('active');
  }

  // 버튼 누르자마자 바로 계산 결과 반영
  calculate();
}

// calculate() 함수 안에서 값을 가져올 때:
// const selectedLang = document.getElementById('stenLang').value;

function calculate() {
  // 선택된 규격, 종류, 수량 가져오기
  const size = parseInt(document.getElementById('size').value);
  const type = parseInt(document.getElementById('type').value);
  const quantityStr = document.getElementById('quantity').value;

  if (quantityStr.trim() === '') {
    alert('수량을 입력해주세요.');
    return;
  }
  const quantity = parseInt(quantityStr);
  if (isNaN(quantity) || quantity <= 0) {
    alert('수량을 입력해주세요.');
    return;
  }

  // 한영 구분이 필요한 6개 항목 (3:갈바오사이, 4:갈바캡잔넬, 6:타카잔넬, 8:스텐오사이, 9:스텐후광, 10:골드스텐)
  const langTargetTypes = [3, 4, 6, 8, 9, 10];
  let selectedLang = 'eng';

  // 아까 HTML에서 만든 <input type="hidden" id="selectedLang">의 ID와 똑같이 맞춰야 합니다.
  if (langTargetTypes.includes(type)) {
    const langInput = document.getElementById('selectedLang'); // 'stenLang' 대신 'selectedLang' 사용
    if (langInput) {
      selectedLang = langInput.value;
    }
  }
  // 선택된 종류에 따라 가격표 설정
  let priceTable = [];
  switch (type) {
    case 1: // 갈바후광영문
      priceTable = [
        29000, 35000, 39000, 42000, 45000, 48000, 52000, 56000, 60000, 65000,
        70000, 76000, 83000, 90000, 99000, 115000, 139000, 165000, 195000,
        225000, 250000, 290000, 330000, 370000,
      ];
      break;

    case 2: // 갈바후광한글
      priceTable = [
        39000, 46000, 50000, 54000, 59000, 63000, 69000, 75000, 82000, 88000,
        95000, 105000, 115000, 125000, 134000, 147000, 175000, 210000, 240000,
        280000, 330000, 370000, 420000, 470000,
      ];
      break;

    case 3: // 갈바오사이
      if (selectedLang === 'kor') {
        priceTable = [
          62000, 62000, 62000, 68000, 75000, 82000, 90000, 100000, 110000,
          123000, 135000, 152000, 170000, 187000, 222000, 246000, 270000,
          295000, 350000, 410000, 450000, 550000, 620000, 700000, 790000,
        ];
      } else {
        priceTable = [
          53000, 53000, 62000, 68000, 75000, 82000, 90000, 100000, 110000,
          123000, 135000, 152000, 170000, 187000, 222000, 246000, 270000,
          295000, 350000, 410000, 450000, 550000, 620000, 700000, 790000,
        ];
      }
      break;

    case 4: // 갈바캡잔넬
      if (selectedLang === 'kor') {
        priceTable = [
          55000, 55000, 55000, 60000, 66000, 72000, 78000, 85000, 93000, 103000,
          112000, 120000, 135000, 148000, 175000, 202000, 240000, 280000,
          330000, 360000, 450000, 510000, 570000, 640000,
        ];
      } else {
        priceTable = [
          51000, 51000, 55000, 60000, 66000, 72000, 78000, 85000, 93000, 103000,
          112000, 120000, 135000, 148000, 175000, 202000, 240000, 280000,
          330000, 360000, 450000, 510000, 570000, 640000,
        ];
      }
      break;

    case 5: // 일체형잔넬
      priceTable = [
        40000, 45000, 53000, 60000, 65000, 70000, 75000, 82000, 90000, 100000,
        110000, 120000, 130000, 145000, 160000, 177000, 196000, 215000,
      ];
      break;

    case 6: // 타카잔넬
      if (selectedLang === 'kor') {
        priceTable = [
          31000, 31000, 31000, 33000, 36000, 38000, 42000, 46000, 49000, 52000,
          57000, 60000, 66000, 75000, 80000, 97000, 120000,
        ];
      } else {
        priceTable = [
          29000, 29000, 31000, 33000, 36000, 38000, 42000, 46000, 49000, 52000,
          57000, 60000, 66000, 75000, 80000, 97000, 120000,
        ];
      }
      break;

    case 7: // 스텐알미늄캡
      priceTable = [
        57000, 57000, 69000, 80000, 90000, 95000, 100000, 107000, 118000,
        130000, 148000, 160000, 171000, 193000, 211000, 252000, 298000, 360000,
        410000, 500000, 580000, 670000, 760000, 860000, 960000,
      ];
      break;

    case 8: // 스텐오사이
      if (selectedLang === 'kor') {
        priceTable = [
          85000, 85000, 104000, 117000, 124000, 131000, 139000, 154000, 169000,
          193000, 208000, 223000, 251000, 275000, 328000, 350000, 380000,
          430000, 520000, 600000, 680000, 780000, 890000, 1010000, 1130000,
        ];
      } else {
        priceTable = [
          74000, 74000, 104000, 117000, 124000, 131000, 139000, 154000, 169000,
          193000, 208000, 223000, 251000, 275000, 328000, 350000, 380000,
          430000, 520000, 600000, 680000, 780000, 890000, 1010000, 1130000,
        ];
      }
      break;

    case 9: // 스텐후광
      if (selectedLang === 'kor') {
        priceTable = [
          50000, 50000, 50000, 70000, 78000, 83000, 90000, 95000, 105000,
          113000, 128000, 147000, 165000, 185000, 200000, 227000, 259000,
          325000, 386000, 440000, 510000, 581000, 650000, 730000,
        ];
      } else {
        priceTable = [
          43000, 43000, 50000, 70000, 78000, 83000, 90000, 95000, 105000,
          113000, 128000, 147000, 165000, 185000, 200000, 227000, 259000,
          325000, 386000, 440000, 510000, 581000, 650000, 730000,
        ];
      }
      break;

    case 10: // 골드스텐
      if (selectedLang === 'kor') {
        priceTable = [
          55000, 55000, 55000, 55000, 65000, 78000, 85000, 95000, 110000,
          126000, 138000, 151000, 162000, 189000, 216000, 234000, 252000,
          306000, 369000, 441000, 522000,
        ];
      } else {
        priceTable = [
          45000, 45000, 55000, 55000, 65000, 78000, 85000, 95000, 110000,
          126000, 138000, 151000, 162000, 189000, 216000, 234000, 252000,
          306000, 369000, 441000, 522000,
        ];
      }
      break;

    default:
      alert('종류를 선택해주세요.');
      return;
  }

  // 선택된 규격에 해당하는 단가 가져오기
  let index = -1;
  if (size >= 200 && size <= 1000 && size % 50 === 0) {
    index = (size - 200) / 50;
  } else if (size > 1000 && size <= 2000 && size % 100 === 0) {
    index = 16 + (size - 1000) / 100;
  }

  if (index === -1 || index >= priceTable.length) {
    alert('단가표에 해당 금액이 없습니다.');
    return;
  }

  const unitPrice = priceTable[index];

  // 총 가격 계산
  const totalPrice = unitPrice * quantity;

  // 총 가격에 쉼표 추가
  const totalPriceWithComma = totalPrice.toLocaleString();

  // 결과 출력
  const result = `${document.getElementById('type').options[type - 1].text} ${size}mm(${formatPrice(unitPrice)}원)  × ${quantity}개 = ${totalPriceWithComma}원`;
  document.getElementById('result').innerHTML = result + '<br><br>';
}

//잔넬계산기 엔터키로 계산하기 -M에 focus 이벤트
quantity.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

// 사용자가 input 박스를 클릭하면 기본값 지우기
document.getElementById('quantity').addEventListener('click', function () {
  const input = document.getElementById('quantity');
  if (input.value === '1') {
    input.value = '';
  }
});

//LED관련 변수
// LED 글씨체 버튼 변수
const headLineButton = document.getElementById('headLineButton');
const godikButton = document.getElementById('godikButton');
const squareButton = document.getElementById('squareButton');
const circleButton = document.getElementById('circleButton');

//LED 수량 변수
const ledResult = document.getElementById('ledResult');

let index = -1; // index를 전역 변수로 설정합니다.
let channelType = '';

// 버튼 클릭 시 index 설정하는 함수
headLineButton.addEventListener('click', function () {
  index = 0;
  channelType = '헤드라인체';
  ledCount();
});
godikButton.addEventListener('click', function () {
  index = 1;
  channelType = '고딕체';
  ledCount();
});
squareButton.addEventListener('click', function () {
  index = 2;
  channelType = '정사각형';
  ledCount();
});
circleButton.addEventListener('click', function () {
  index = 3;
  channelType = '원형';
  ledCount();
});

// LED 개수를 반환하는 함수
function ledCount() {
  const size = parseInt(document.getElementById('size').value);
  //잔넬 글자 갯수 가져오기
  const quantityStr = parseInt(document.getElementById('quantity').value);
  //KPL 가격
  const kplPrice = 750;
  //미들2구 가격
  const midPrice = 740;

  // LED 갯수 테이블
  let ledNumberTable = [];
  switch (size) {
    case 200:
      ledNumberTable = [20, 18, 8, 7];
      break;
    case 250:
      ledNumberTable = [23, 21, 11, 10];
      break;
    case 300:
      ledNumberTable = [15, 13, 16, 13];
      break;
    case 350:
      ledNumberTable = [19, 17, 22, 18];
      break;
    case 400:
      ledNumberTable = [22, 20, 28, 22];
      break;
    case 450:
      ledNumberTable = [26, 24, 36, 28];
      break;
    case 500:
      ledNumberTable = [30, 28, 43, 34];
      break;
    case 550:
      ledNumberTable = [35, 33, 52, 41];
      break;
    case 600:
      ledNumberTable = [40, 37, 61, 48];
      break;
    case 650:
      ledNumberTable = [48, 42, 72, 57];
      break;
    case 700:
      ledNumberTable = [55, 47, 82, 65];
      break;
    case 750:
      ledNumberTable = [63, 54, 95, 75];
      break;
    case 800:
      ledNumberTable = [70, 60, 107, 85];
      break;
    case 850:
      ledNumberTable = [80, 68, 121, 96];
      break;
    case 900:
      ledNumberTable = [90, 75, 135, 107];
      break;
    case 950:
      ledNumberTable = [100, 83, 151, 119];
      break;
    case 1000:
      ledNumberTable = [110, 90, 167, 131];
      break;
    case 1100:
      ledNumberTable = [135, 108, 201, 159];
      break;
    case 1200:
      ledNumberTable = [160, 127, 240, 188];
      break;
    case 1300:
      ledNumberTable = [190, 147, 281, 221];
      break;
    case 1400:
      ledNumberTable = [220, 170, 325, 256];
      break;
    case 1500:
      ledNumberTable = [250, 194, 373, 294];
      break;
    case 1600:
      ledNumberTable = [285, 220, 425, 334];
      break;
    case 1700:
      ledNumberTable = [320, 247, 479, 377];
      break;
    case 1800:
      ledNumberTable = [360, 277, 537, 422];
      break;
    case 1900:
      ledNumberTable = [400, 307, 598, 470];
      break;
    case 2000:
      ledNumberTable = [450, 340, 663, 521];
      break;
    default:
      alert('LED가 들어갈 잔넬 사이즈를 선택해주세요.');
      return;
  }

  // index가 설정되지 않았거나 유효한 범위를 벗어나면 경고 메시지를 출력합니다.
  if (index === -1 || index >= ledNumberTable.length) {
    alert('LED가 들어갈 잔넬 사이즈를 선택해주세요.');
    return;
  }

  // index에 따라 ledNumber를 설정합니다.
  const ledNumber = ledNumberTable[index];

  const numberResult = quantityStr * ledNumber;
  const kplPriceResult = kplPrice * numberResult;
  const midPriceResult = midPrice * numberResult;

  // size가 200이고, 헤드라인,고딕체일때 미들2구를 넣음
  if (size === 200) {
    if (index === 0 || index === 1) {
      ledResult.innerHTML = `${channelType} 잔넬 ${size}mm <br> 글자당 ${ledNumber}개 x ${quantityStr}글자 = 미들2구 ${numberResult}개 조립(740원) <br> 합계: ${formatPrice(midPriceResult)}원 `;
    } else {
      ledResult.innerHTML = `${channelType} 잔넬 ${size}mm <br> 글자당 ${ledNumber}개 x ${quantityStr}글자 = KPL ${numberResult}개 조립(750원) <br> 합계: ${formatPrice(kplPriceResult)}원 `;
    }
  }
  // size가 250이고, 헤드라인,고딕체일때 미들2구를 넣음
  else if (size === 250) {
    if (index === 0 || index === 1) {
      ledResult.innerHTML = `${channelType} 잔넬 ${size}mm <br> 글자당 ${ledNumber}개 x ${quantityStr}글자 = 미들2구 ${numberResult}개 조립(740원) <br> 합계: ${formatPrice(midPriceResult)}원 `;
    } else {
      ledResult.innerHTML = `${channelType} 잔넬 ${size}mm <br> 글자당 ${ledNumber}개 x ${quantityStr}글자 = KPL ${numberResult}개 조립(750원) <br> 합계: ${formatPrice(kplPriceResult)}원 `;
    }
  }
  // size가 200, 250이 아닐 때는 KPL을 넣음
  else {
    ledResult.innerHTML = `${channelType} 잔넬 ${size}mm <br> 글자당 ${ledNumber}개 x ${quantityStr}글자 = KPL ${numberResult}개 조립(750원) <br> 합계: ${formatPrice(kplPriceResult)}원 `;
  }
}

//바후렘, 일반후렘 버튼변수
const barFrame = document.getElementById('barFrame');
const normalFrame = document.getElementById('normalFrame');

//바후렘, 일반후렘 컨테이너 변수
const barContainer = document.getElementById('barContainer');
const normalContainer = document.getElementById('normalContainer');

//바 후렘 변수
const alminumBar = document.getElementById('alminumBar');
const galbaBar = document.getElementById('galbaBar');

//바후렘 계산기변수(div 박스묶음용)
const alminumBarCalc = document.getElementById('alminumBarCalc');
const galbaBarCalc = document.getElementById('galbaBarCalc');

//일반후렘 계산기변수(div 박스묶음용)
const normalCalc = document.getElementById('normalCalc');

//실제 계산용 일반후렘 변수
const normal_calc = document.getElementById('normal-calc');
const normal_width = document.getElementById('normal-width');
const normal_height = document.getElementById('normal-height');
const normal_result = document.getElementById('normal-result');

//실제 계산용 일반후렘 계산하기 버튼
const normal_calc_btn = document.getElementById('normal-calc-btn');

//실제 계산용 알미늄 바 변수
const alminumBar_calc = document.getElementById('alminumBar-calc');
const alminumBar_length = document.getElementById('alminumBar-length');
const alminumBar_result = document.getElementById('alminumBar-result');

//실제 계산용 갈바 바 변수
const galbaBar_calc = document.getElementById('galbaBar-calc');
const galbaBar_length = document.getElementById('galbaBar-length');
const galbaBar_height = document.getElementById('galbaBar-height');
const galbaBar_result = document.getElementById('galbaBar-result');

//실제 계산용 알미늄,갈바 계산하기버튼
const alminumBar_calc_btn = document.getElementById('alminumBar-calc-btn');
const galbaBar_calc_btn = document.getElementById('galbaBar-calc-btn');

//숨기기가 가능한 박스묶음
const canHide = document.getElementsByClassName('canHide');

// 모든 계산기 숨기는 함수
function hideAllCanHide() {
  for (let i = 0; i < canHide.length; i++) {
    canHide[i].style.display = 'none';
  }
}

//초기화면 버튼 숨기기
hideAllCanHide();

//바후렘 버튼추가를 눌렀을때
barFrame.addEventListener('click', () => {
  hideAllCanHide();
  barContainer.style.display = 'block';
  alminumBarCalc.style.display = 'none';
  galbaBarCalc.style.display = 'none';
});

//일반 후렘 버튼추가 를 눌렀을때
normalFrame.addEventListener('click', () => {
  hideAllCanHide();
  normalContainer.style.display = 'block';
});

//알미늄 후렘 버튼을 눌렀을때
alminumBar.addEventListener('click', () => {
  galbaBarCalc.style.display = 'none';
  alminumBarCalc.style.display = 'block';
});

//갈바 후렘 버튼을 눌렀을때
galbaBar.addEventListener('click', () => {
  alminumBarCalc.style.display = 'none';
  galbaBarCalc.style.display = 'block';
});

// 얼마늄바 후렘 계산 버튼 클릭 시
alminumBar_calc_btn.addEventListener('click', () => {
  const length = alminumBar_length.value;
  const price = 45000;
  const result = length * price;
  alminumBar_result.textContent = `알미늄 바 후렘 ${length}M = ${formatPrice(result)}원`;
});

// 갈바 후렘 계산 버튼 클릭 시
galbaBar_calc_btn.addEventListener('click', () => {
  const height = galbaBar_height.value;
  const length = galbaBar_length.value;
  let price;
  if (height === '200') {
    price = 45000;
  } else if (height === '300') {
    price = 50000;
  } else if (height === '400') {
    price = 60000;
  }
  const result = length * price;
  galbaBar_result.textContent = `갈바 바 후렘 ${height}mm, ${length}M = ${formatPrice(result)}원`;
});

// 일반 후렘 계산 버튼 클릭 시
normal_calc_btn.addEventListener('click', () => {
  const width = normal_width.value;
  const height = normal_height.value;
  const result = ((width * height) / 1000000) * 120000;
  normal_result.textContent = `일반 후렘(갈바) ${width} * ${height} = ${formatPrice(result)}원`;
});

// 가격 포맷 함수
function formatPrice(price) {
  return new Intl.NumberFormat('ko-KR', {
    maximumSignificantDigits: 3,
  }).format(price);
}

// 알미늄바 엔터키로 계산하기-M에 focus이벤트
alminumBar_length.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

//갈바 바 엔터키로 계산하기 -M에 focus 이벤트
galbaBar_length.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

// 일반후렘 엔터키로 계산하기-M에 focus이벤트
normal_width.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});
normal_height.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

// enter 키 이벤트 핸들러 함수
function calculateOnEnter(event) {
  if (event.keyCode === 13) {
    const activeInput = document.activeElement;
    if (activeInput.tagName.toLowerCase() === 'input') {
      event.preventDefault();
      const calcBtn = activeInput.parentElement.querySelector('button');
      calcBtn.click();
    }
  }
}

// 해당 input 요소에서 focus가 해제될 때, enter 키 이벤트 핸들러 제거
alminumBar_length.addEventListener('blur', () => {
  document.removeEventListener('keydown', calculateOnEnter);
});

const EPOXY_MATERIAL = [
  {
    value: 'galvalume',
    text: '갈바',
  },
  {
    value: 'stainless',
    text: '스텐',
  },
];

const EPOXY_SIZE = [
  100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400,
];

const EPOXY_TEXT_TYPE = [
  {
    value: 'korean',
    text: '한글',
  },
  {
    value: 'englishNumber',
    text: '영문,숫자',
  },
];

const EPOXY_STROKE = [
  {
    value: '30',
    text: '30(1줄)',
  },
  {
    value: '50',
    text: '50(2줄)',
  },
  {
    value: '70',
    text: '70(3줄)',
  },
  {
    value: '90',
    text: '90(4줄)',
  },
  {
    value: '110',
    text: '110(5줄)',
  },
];

// HOMEWORK - 없는 데이터를 선택하지 않도록 구조를 바꿔보자. (EX. 갈바 100 한글에 5줄은 없으니까 리스트에 아예 없도록)
// 선택했는데 없다고 그러면 좋은 UX가 아니다. (569번째 줄)

// 에폭시에 데이터로 select의 option을 그려주는 함수
const drawEpoxyCalculator = () => {
  const epoxyMaterial = document.getElementById('epoxyMaterial');
  const epoxyTextType = document.getElementById('epoxyTextType');
  const epoxySize = document.getElementById('epoxySize');
  const epoxyStroke = document.getElementById('epoxyStroke');

  // 에폭시 재질 option 그리기
  EPOXY_MATERIAL.forEach(material => {
    const option = document.createElement('option');
    option.value = material.value;
    option.text = material.text;
    epoxyMaterial.appendChild(option);
  });

  // 에폭시 텍스트 타입 option 그리기
  EPOXY_TEXT_TYPE.forEach(textType => {
    const option = document.createElement('option');
    option.value = textType.value;

    option.text = textType.text;
    epoxyTextType.appendChild(option);
  });

  // 에폭시 사이즈 option 그리기
  EPOXY_SIZE.forEach(size => {
    const option = document.createElement('option');
    option.value = size;
    option.text = size;
    epoxySize.appendChild(option);
  });

  // 에폭시 줄 option 그리기
  EPOXY_STROKE.forEach(stroke => {
    const option = document.createElement('option');
    option.value = stroke.value;
    option.text = stroke.text;
    epoxyStroke.appendChild(option);
  });
};

// switch문을 대신하기 위한 오브젝트.
// 하지만, 이것도 데이터 변경이 필요할 때마다 코드를 수정해야 하므로 정말 불편하고 유지보수가 쉽지 않은 형태이다.
// const EPOXY_TABLE = {
//   갈바100한글: [45000, 50000],
//   갈바100영문숫자: [35000, 40000],
//   갈바125한글: [55000, 75000],
//   갈바125영문숫자: [44000, 51000],
// ...
// }

// EPOXY_PRICE_TABLE[material][textType][sizeIndex][strokeIndex]
const EPOXY_PRICE_TABLE = {
  galvalume: {
    korean: [
      [50000, 60000],
      [60000, 75000],
      [70000, 84000],
      [82000, 97000, 108000],
      [94000, 108000, 122000],
      [105000, 120000, 135000],
      [116000, 132000, 150000, 164000],
      [126000, 145000, 163000, 180000],
      [145000, 164000, 186000, 205000, 223000],
      [154000, 177000, 200000, 222000, 238000],
      [165000, 189000, 213000, 238000, 262000],
      [176000, 202000, 185000, 253000, 278000],
      [190000, 212000, 210000, 263000, 288000],
    ],
    englishNumber: [
      [39000, 42000],
      [44000, 51000],
      [51000, 59000, 68000],
      [59000, 70000, 79000],
      [66000, 79000, 88000],
      [80000, 92000, 102000],
      [94000, 104000, 115000, 132000],
      [110000, 121000, 133000, 143000],
      [125000, 138000, 150000, 163000, 176000],
      [136000, 148000, 162000, 176000, 189000],
      [145000, 160000, 173000, 188000, 204000],
      [154000, 169000, 238000, 200000, 216000],
      [170000, 179000, 195000, 210000, 226000],
    ],
  },
  stainless: {
    korean: [
      [55000],
      [70000, 77000],
      [81000, 92000],
      [93000, 103000, 116000],
      [102000, 116000, 127000],
      [113000, 126000, 140000, 154000],
      [129000, 145000, 161000, 174000],
      [151000, 159000, 176000, 192000],
      [159000, 178000, 198000, 215000, 231000],
      [173000, 193000, 215000, 235000, 251000],
      [184000, 206000, 228000, 251000, 273000],
      [193000, 217000, 240000, 263000, 288000],
      [205000, 227000, 250000, 263000, 298000],
    ],
    englishNumber: [
      [45000],
      [55000, 72000],
      [66000, 84000],
      [77000, 97000, 103000],
      [83000, 106000, 116000],
      [91000, 117000, 126000, 136000],
      [110000, 135000, 145000, 156000],
      [136000, 147000, 159000, 170000],
      [152900, 165000, 178000, 190000, 203000],
      [167000, 181000, 194000, 209000, 222000],
      [178000, 192000, 206000, 221000, 236000],
      [187000, 202000, 217000, 232000, 249000],
      [197000, 212000, 227000, 232000, 259000],
    ],
  },
};

// 여기서부터 에폭시 계산기
function epoxyCalc() {
  // 변수 불러오기
  const {
    value: epoxyMaterial,
    selectedOptions: selectedEpoxyMaterialOptions,
  } = document.getElementById('epoxyMaterial');
  const {
    value: epoxyTextType,
    selectedOptions: selectedEpoxyTextTypeOptions,
  } = document.getElementById('epoxyTextType');
  const { value: epoxySize, selectedIndex: epoxySizeIndex } =
    document.getElementById('epoxySize');
  const { value: epoxyStroke, selectedIndex: epoxyStrokeIndex } =
    document.getElementById('epoxyStroke');
  const epoxyQuantity = document.getElementById('epoxyQuantity').value;

  let epoxyResult = 0;

  // 선택에 따라 가격표에서 단가 가져오기
  // EPOXY_PRICE_TABLE[material][textType][sizeIndex][strokeIndex]
  const epoxyUnitPrice =
    EPOXY_PRICE_TABLE[epoxyMaterial][epoxyTextType][epoxySizeIndex][
      epoxyStrokeIndex
    ];
  if (epoxyUnitPrice) {
    epoxyResult = epoxyUnitPrice * epoxyQuantity;
  } else {
    // 없으면 에러 메시지 출력
    alert('단가표에 해당 금액이 없습니다.');
    return;
  }

  //결과 출력
  document.getElementById('epoxyResult').innerHTML =
    `${selectedEpoxyMaterialOptions[0].innerText} 에폭시 ${epoxySize}mm ${selectedEpoxyTextTypeOptions[0].innerText} ${epoxyStroke}mm x ${epoxyQuantity}개 = ${formatPrice(epoxyResult)}원`;
}

// 사용자가 input 박스를 클릭하면 기본값 지우기
document.getElementById('epoxyQuantity').addEventListener('click', function () {
  const input = document.getElementById('epoxyQuantity');
  if (input.value === '1') {
    input.value = '';
  }
});

//에폭시 엔터키로 계산하기 -M에 focus 이벤트
epoxyQuantity.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

// 여기서부터 아크릴계산기
function acrylCalc() {
  const acrylKoEng = document.getElementById('acrylKoEng').value;
  const acrylT = document.getElementById('acrylT').value;
  const acrylH = parseInt(document.getElementById('acrylH').value);
  const acrylQ = parseInt(document.getElementById('acrylQ').value);

  // const acrylStr 필요한지?

  //아크릴 단가표 2차배열 priceTable[0][0] == 360
  let priceTable = [
    // [420, 540, 700, 800, 900, 1100, 1100, 1500, 1700, 2300, 3500, 5000, 7000, 8000],
    [
      480, 660, 800, 900, 1000, 1200, 1400, 1800, 2000, 2700, 4000, 5500, 8000,
      9000,
    ],
    [
      600, 720, 900, 1000, 1100, 1500, 1600, 2000, 2400, 3000, 4500, 6500, 9000,
      10000,
    ],
    [
      660, 840, 1000, 1100, 1200, 1700, 1800, 2300, 2700, 3500, 5000, 7500,
      10000, 11000,
    ],
    [
      780, 960, 1100, 1400, 1500, 1800, 2000, 2600, 3000, 4000, 5700, 8500,
      11000, 12000,
    ],
    [
      840, 1100, 1200, 1500, 1700, 2100, 2300, 2900, 3400, 4400, 6500, 9500,
      12000, 13000,
    ],
    [
      960, 1200, 1400, 1600, 1800, 2300, 2600, 3200, 3800, 5000, 7500, 10500,
      13000, 14000,
    ],
    [
      1100, 1400, 1500, 1700, 2100, 2600, 2800, 3600, 4200, 5500, 8500, 11500,
      14000, 15000,
    ],
    [
      1200, 1500, 1600, 2000, 2200, 2800, 3100, 3900, 4600, 6000, 9000, 12500,
      15000, 16000,
    ],
    [
      1300, 1600, 1700, 2100, 2400, 3000, 3400, 4200, 5000, 6500, 10000, 13500,
      16000, 17000,
    ],

    [
      1500, 1800, 2000, 2300, 2700, 3300, 3700, 4600, 5400, 7000, 11000, 14500,
      17000, 18000,
    ],
    [
      1600, 2000, 2100, 2400, 2900, 3600, 4000, 5000, 5800, 7500, 12000, 15500,
      18000, 19000,
    ],
    [
      1700, 2100, 2200, 2700, 3200, 3900, 4300, 5300, 6300, 8000, 13000, 16500,
      19000, 20000,
    ],
    [
      1800, 2200, 2300, 2800, 3500, 4100, 4700, 5700, 6700, 9000, 14000, 17500,
      20000, 21000,
    ],
    [
      2000, 2300, 2600, 3000, 3600, 4500, 5000, 6200, 7200, 9500, 15000, 18500,
      21000, 22000,
    ],
    [
      2100, 2600, 2700, 3300, 3900, 4700, 5400, 6700, 7700, 10000, 16000, 19000,
      22000, 23000,
    ],
    [
      2300, 2700, 2900, 3400, 4100, 5100, 5700, 7000, 8200, 10500, 17000, 21000,
      23000, 24500,
    ],
    [
      2400, 2900, 3000, 3600, 4400, 5300, 6100, 7400, 8700, 11000, 18000, 22000,
      24000, 26000,
    ],
    [
      2600, 3000, 3300, 3900, 4700, 5700, 6500, 7800, 9200, 11500, 19000, 23000,
      25000, 27500,
    ],
    [
      2700, 3200, 3500, 4100, 5000, 6000, 7000, 8300, 10000, 12000, 20000,
      24000, 26000, 29000,
    ],

    [
      2900, 3400, 3800, 4400, 5200, 6300, 7300, 8700, 10500, 12700, 21000,
      25000, 27000, 31000,
    ],
    [
      3000, 3500, 3900, 4600, 5600, 6600, 7700, 9200, 11000, 13500, 22000,
      26000, 28000, 33000,
    ],
    [
      3300, 3800, 4100, 4800, 5800, 7000, 8000, 9600, 11500, 14000, 23000,
      27000, 29000, 35000,
    ],
    [
      3400, 4000, 4200, 5100, 6000, 7200, 8500, 10000, 12000, 14500, 24000,
      28000, 30000, 37000,
    ],
    [
      3500, 4100, 4300, 5300, 6200, 7400, 9000, 10500, 12500, 15000, 25000,
      29000, 31000, 39000,
    ],
    [
      3600, 4300, 4400, 4600, 6600, 7600, 9500, 11000, 12800, 15500, 26000,
      30000, 32000, 41000,
    ],
    [
      3700, 4500, 4500, 4900, 6800, 7800, 9800, 11500, 13200, 16000, 27000,
      31000, 33000, 43000,
    ],
    [
      3800, 4700, 4600, 5200, 7000, 8200, 10100, 12000, 13600, 17000, 28000,
      32000, 34000, 45000,
    ],
    [
      3900, 4900, 4700, 5500, 7200, 8600, 10400, 12500, 14000, 18000, 29000,
      33000, 35000, 48000,
    ],
    [
      4000, 5100, 4800, 5800, 7400, 9000, 10700, 13000, 15000, 19000, 30000,
      34000, 36000, 51000,
    ],

    [
      4100, 5300, 4900, 6100, 7600, 9400, 11000, 13500, 15500, 20000, 31000,
      36000, 37000, 54000,
    ],
    [
      4200, 5500, 5000, 6400, 7800, 9800, 11300, 14000, 16000, 21000, 32000,
      38000, 38000, 57000,
    ],
    [
      4300, 5700, 5100, 6700, 8200, 10200, 11600, 14500, 16500, 22000, 33000,
      40000, 39000, 60000,
    ],
    [
      4400, 5900, 5200, 7000, 8600, 10600, 11900, 15000, 17000, 23000, 34000,
      42000, 40000, 63000,
    ],
    [
      4500, 6100, 5300, 7300, 9000, 11000, 12200, 15600, 17500, 24000, 35000,
      44000, 41000, 66000,
    ],
    [
      4600, 6300, 5400, 7600, 9400, 11400, 12500, 16200, 18000, 25000, 36000,
      46000, 42000, 69000,
    ],
    [
      4700, 6500, 5500, 8000, 9900, 11800, 12800, 16800, 18500, 26000, 37000,
      48000, 43000, 72000,
    ],
    [
      4800, 6700, 5600, 8400, 10400, 11500, 13100, 17400, 19000, 27000, 38000,
      50000, 44000, 75000,
    ],
    [
      4900, 6900, 5700, 8800, 10900, 12000, 13400, 18000, 20500, 28000, 39000,
      52000, 45000, 78000,
    ],
    [
      5000, 7100, 5900, 9200, 11400, 12500, 13700, 19000, 21000, 29000, 40000,
      54000, 46000, 81000,
    ],

    [
      5200, 7400, 6100, 9700, 11900, 13500, 14200, 20000, 21500, 30000, 41000,
      56000, 47000, 84000,
    ],
    [
      5400, 7700, 6400, 10200, 12400, 14500, 14700, 21000, 22000, 31000, 42000,
      58000, 48000, 87000,
    ],
    [
      5600, 8000, 6700, 10700, 12900, 15500, 15200, 22000, 22500, 32000, 43000,
      60000, 49000, 90000,
    ],
    [
      5800, 8300, 7200, 11200, 13400, 16500, 15700, 23000, 23000, 33000, 44000,
      62000, 50000, 93000,
    ],
    [
      6000, 8600, 7500, 11700, 13900, 17500, 16200, 24000, 23500, 34000, 45000,
      64000, 52000, 96000,
    ],
    [
      6200, 8900, 7800, 12200, 14400, 18500, 16700, 25000, 24000, 35000, 46000,
      66000, 54000, 99000,
    ],
    [
      6400, 9200, 8100, 12700, 14900, 19500, 17200, 26000, 24500, 36000, 47000,
      68000, 56000, 102000,
    ],
    [
      6600, 9500, 8400, 13200, 15400, 20500, 17700, 27000, 25000, 37000, 48000,
      70000, 58000, 105000,
    ],
    [
      6800, 9800, 8700, 13700, 15900, 21500, 18200, 28000, 26000, 38000, 49000,
      73000, 60000, 108000,
    ],
    [
      7000, 10300, 9100, 14700, 16400, 22500, 18700, 29000, 27000, 39000, 50000,
      76000, 62000, 111000,
    ],

    [
      7200, 10800, 9500, 15700, 16900, 23500, 19200, 30000, 28000, 40000, 51000,
      79000, 65000, 114000,
    ],
    [
      7400, 11300, 9900, 16700, 17500, 24500, 19700, 31000, 29000, 42000, 52000,
      82000, 68000, 117000,
    ],
    [
      7600, 11800, 10300, 17700, 18100, 25500, 20200, 32000, 30000, 44000,
      53000, 85000, 71000, 120000,
    ],
    [
      7800, 12300, 10700, 18700, 18700, 26500, 20700, 33000, 31000, 46000,
      54000, 88000, 74000, 124000,
    ],
    [
      8000, 12800, 11100, 19700, 19300, 27500, 21200, 34000, 32000, 48000,
      55000, 92000, 77000, 128000,
    ],
    [
      8500, 13800, 12100, 20700, 19900, 28500, 21700, 35000, 33000, 50000,
      56000, 96000, 80000, 132000,
    ],
    [
      9000, 14800, 13100, 21700, 20600, 29500, 22200, 36000, 34000, 52000,
      57000, 100000, 84000, 136000,
    ],
    [
      9500, 15800, 14100, 22700, 21600, 30500, 22700, 37000, 35000, 54000,
      58000, 104000, 88000, 140000,
    ],
    [
      10000, 16800, 15100, 23700, 22600, 31500, 23200, 38000, 36000, 56000,
      59000, 108000, 92000, 145000,
    ],
    [
      10500, 17800, 16100, 24700, 23600, 32500, 23700, 39000, 37000, 58000,
      60000, 112000, 96000, 150000,
    ],

    [
      11000, 18800, 17100, 25700, 24600, 33500, 24700, 40000, 38000, 60000,
      61000, 116000, 100000, 155000,
    ],
    [
      11500, 19800, 18100, 26700, 25600, 34500, 25700, 41000, 39000, 62000,
      62000, 120000, 104000, 160000,
    ],
    [
      12000, 20800, 19100, 27700, 26600, 35500, 26700, 42000, 40000, 64000,
      64000, 125000, 108000, 165000,
    ],
    [
      12500, 21800, 20100, 28700, 27600, 36500, 27700, 44000, 41000, 66000,
      66000, 130000, 112000, 170000,
    ],
    [
      13000, 22800, 21300, 29700, 28600, 37500, 28700, 46000, 42000, 68000,
      69000, 135000, 116000, 175000,
    ],
    [
      13500, 23800, 22300, 30700, 29600, 38500, 29700, 48000, 44000, 70000,
      72000, 140000, 120000, 180000,
    ],
    [
      14000, 24800, 23300, 31700, 30600, 39500, 30700, 50000, 46000, 73000,
      75000, 145000, 125000, 185000,
    ],
    [
      14500, 25800, 24300, 32700, 31600, 40500, 31700, 52000, 48000, 76000,
      80000, 150000, 130000, 190000,
    ],
    [
      15000, 26800, 25300, 33700, 32600, 42500, 32700, 54000, 50000, 79000,
      85000, 155000, 135000, 195000,
    ],
    [
      15500, 27800, 26300, 34700, 33600, 44500, 33700, 56000, 52000, 82000,
      90000, 160000, 140000, 200000,
    ],

    [
      16300, 28800, 27300, 36700, 34600, 48500, 34700, 58000, 54000, 85000,
      95000, 165000, 145000, 205000,
    ],
    [
      17100, 29800, 28300, 38700, 35600, 52500, 35700, 60000, 56000, 89000,
      100000, 170000, 150000, 210000,
    ],
    [
      17900, 30800, 29300, 40700, 36600, 56500, 36700, 63000, 58000, 93000,
      105000, 175000, 155000, 215000,
    ],
    [
      18700, 31800, 30300, 42700, 37600, 60500, 37700, 66000, 60000, 97000,
      110000, 180000, 160000, 220000,
    ],
    [
      19500, 32800, 31300, 44700, 38600, 64500, 38700, 69000, 62000, 101000,
      115000, 185000, 165000, 225000,
    ],
    [
      20300, 33800, 32300, 46700, 39600, 68500, 39700, 72000, 64000, 105000,
      120000, 190000, 170000, 230000,
    ],
    [
      21300, 34800, 33300, 48700, 40600, 70500, 41700, 75000, 66000, 110000,
      125000, 195000, 175000, 235000,
    ],
    [
      22300, 35800, 34300, 50700, 41600, 72500, 43700, 78000, 68000, 115000,
      130000, 200000, 180000, 240000,
    ],
    [
      23300, 36800, 35300, 52700, 42600, 74500, 45700, 81000, 70000, 120000,
      135000, 205000, 185000, 245000,
    ],
    [
      24300, 37800, 36300, 54700, 43600, 76500, 47700, 84000, 72000, 125000,
      140000, 210000, 190000,
    ],

    [
      25300, 38800, 37300, 56700, 44600, 78500, 49700, 87000, 74000, 130000,
      145000, 215000,
    ],
    [
      26300, 39800, 38300, 58700, 45600, 80500, 51700, 90000, 76000, 135000,
      160000,
    ],
    [27300, 40800, 39300, 60700, 46600, 82500, 53700, 93000, 78000, 140000],
    [28300, 41800, 40300, 62700, 47600, 84500, 55700, 96000, 80000, 145000],
    [29300, 42800, 41300, 64700, 48600, 86500, 57700, 100000, 85000, 150000],
    [30300, 43800, 42300, 66700, 49600, 88500, 59700, 104000, 85000, 150000],
    [31300, 44800, 43300, 68700, 50600, 90500, 61700],
    [32300, 45800, 44300, 70700, 51600, 92500, 63700],
  ];

  // 초기 인덱스 설정
  let firstIndex = -1;
  let secondIndex = -1;

  // firstIndex 설정
  if (acrylH <= 30) {
    firstIndex = 0;
  } else if (acrylH > 900) {
    firstIndex = -1;
    document.getElementById('acrylResult').innerHTML =
      '단가표에 없는 사이즈입니다.';
  } else {
    firstIndex = Math.ceil((acrylH - 30) / 10);
  }

  // secondIndex 설정
  switch (acrylT) {
    case '2T':
      if (acrylKoEng === '영문') {
        secondIndex = 0;
      } else if (acrylKoEng === '한글') {
        secondIndex = 1;
      }
      break;
    case '3T':
      if (acrylKoEng === '영문') {
        secondIndex = 2;
      } else if (acrylKoEng === '한글') {
        secondIndex = 3;
      }
      break;
    case '5T':
      if (acrylKoEng === '영문') {
        secondIndex = 4;
      } else if (acrylKoEng === '한글') {
        secondIndex = 5;
      }
      break;
    case '8T':
      if (acrylKoEng === '영문') {
        secondIndex = 6;
      } else if (acrylKoEng === '한글') {
        secondIndex = 7;
      }
      break;
    case '10T':
      if (acrylKoEng === '영문') {
        secondIndex = 8;
      } else if (acrylKoEng === '한글') {
        secondIndex = 9;
      }
      break;
    case '15T':
      if (acrylKoEng === '영문') {
        secondIndex = 10;
      } else if (acrylKoEng === '한글') {
        secondIndex = 11;
      }
      break;
    case '20T':
      if (acrylKoEng === '영문') {
        secondIndex = 12;
      } else if (acrylKoEng === '한글') {
        secondIndex = 13;
      }
      break;
    default:
      console.log('잘못된 아크릴 T사이즈입니다.');
  }

  const acrylPrice = priceTable[firstIndex]?.[secondIndex];

  if (acrylPrice !== undefined) {
    const acrylResult = acrylPrice * acrylQ;
    document.getElementById('acrylResult').innerHTML =
      `아크릴 ${acrylKoEng} ${acrylT} ${acrylH}mm / ${acrylPrice}원 x ${acrylQ}개 = ${formatPrice(acrylResult)}원`;
  } else {
    document.getElementById('acrylResult').innerHTML =
      '단가표에 해당 가격이 없습니다. (최대 900mm 까지 입력가능)';
  }
}

// 사용자가 input 박스를 클릭하면 기본값 지우기
document.getElementById('acrylQ').addEventListener('click', function () {
  const input = document.getElementById('acrylQ');
  if (input.value === '1') {
    input.value = '';
  }
});

document.getElementById('acrylH').addEventListener('click', function () {
  const input = document.getElementById('acrylH');
  if (input.value === '1') {
    input.value = '';
  }
});

//아크릴 엔터키로 계산하기 -M에 focus 이벤트
acrylQ.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

//아크릴 엔터키로 계산하기 -M에 focus 이벤트
acrylH.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

//
//
//
// 여기서부터 고무스카시 계산기

function gomuCalc() {
  const gomuT = document.getElementById('gomuT').value;
  const gomuH = parseInt(document.getElementById('gomuH').value);
  const gomuQ = parseInt(document.getElementById('gomuQ').value);

  //고무스카시 단가표 2차배열 priceTable[0][0] == 3000
  let priceTable = [
    [3500, 4500, 4000, 4500, 5000, 5400],
    [4000, 5400, 5000, 5400, 6000, 6300],
    [5000, 6300, 6000, 6300, 7000, 7200],
    [6000, 7200, 7000, 7200, 8000, 10500],
    [7500, 10500, 8000, 10500, 9000, 13500],
    [9000, 14100, 11000, 14100, 13500, 19000],
    [11000, 19000, 14000, 19000, 18000, 24000],
    [14000, 23600, 18000, 23600, 22000, 29000],
    [17000, 29000, 22000, 29000, 26000, 35000],
    [20000, 35000, 26000, 35000, 32000, 42000],
    [24000, 42000, 32000, 42000, 37000, 49000],
    [28000, 49000, 37000, 49000, 43500, 56000],
    [32000, 56000, 43500, 56000, 50000, 66000],
    [38000, 66000, 50000, 66000, 56000, 75000],
    [43000, 75000, 56000, 75000, 64000, 84000],
    [48000, 84000, 64000, 84000, 72000, 94500],
    [54000, 94500, 72000, 94500, 80000, 105000],
    [62000, 105000, 80000, 105000, 88000, 116500],
    [66000, 116500, 88000, 116500, 110000, 140000],
    [73000, 140000, 110000, 140000, 130000, 168000],
    [96000, 168000, 130000, 168000, 153000, 196000],
    [112000, 196000, 153000, 196000, 170000, 227500],
    [130000, 227500, 170000, 227500, 200000, 262500],
    [150000, 262500, 200000, 262500, 220000, 297500],
    [170000, 297500, 220000, 297500, 250000, 336000],
    [192000, 336000, 250000, 336000, 280000, 378000],
    [216000, 378000, 280000, 378000, 320000, 420000],
    [240000, 420000, 320000, 420000, 350000, 466000],
    [260000, 467000, 355000, 467000],
  ];

  // 초기 인덱스 설정
  let firstIndex = -1;
  let secondIndex = -1;

  // 테스트 해봐야함 그리고 commit 해야함.
  // firstIndex 설정
  // if (gomuH <= 149) {
  //   firstIndex = 0;
  // } else if (gomuH > 2000) {
  //   firstIndex = -1;
  //   document.getElementById("gomuResult").innerHTML = "단가표에 없는 사이즈입니다.";
  // } else if (150 <= gomuH && gomuH <= 1000) {
  //   firstIndex = Math.ceil((gomuH - 149) / 50);
  // } else if (1001 <= gomuH && gomuH <= 2000) {
  //   firstIndex = 7 + Math.ceil(gomuH / 100);
  // }

  if (gomuH <= 149) {
    firstIndex = 0;
  } else if (gomuH > 2000) {
    firstIndex = -1;
    document.getElementById('gomuResult').innerHTML =
      '단가표에 없는 사이즈입니다.';
  } else if (150 <= gomuH && gomuH <= 1000) {
    firstIndex = Math.ceil((gomuH - 149) / 50);
  } else if (1001 <= gomuH && gomuH <= 2000) {
    firstIndex = 17 + Math.ceil((gomuH - 999) / 100);
  }

  // secondIndex 설정
  switch (gomuT) {
    case '10T':
      secondIndex = 0;
      break;
    case '10T-금은색':
      secondIndex = 1;
      break;
    case '20,30T':
      secondIndex = 2;
      break;
    case '20,30T-금은색':
      secondIndex = 3;
      break;
    case '50T':
      secondIndex = 4;
      break;
    case '50T-금은색':
      secondIndex = 5;
      break;

    default:
      console.log('잘못된 고무 T사이즈입니다.');
  }

  const gomuPrice = priceTable[firstIndex]?.[secondIndex];

  if (gomuPrice !== undefined) {
    const gomuResult = gomuPrice * gomuQ;
    document.getElementById('gomuResult').innerHTML =
      `고무 ${gomuT} ${gomuH}mm / ${formatPrice(gomuPrice)}원 x ${gomuQ}개 = ${formatPrice(gomuResult)}원`;
  } else {
    document.getElementById('gomuResult').innerHTML =
      '단가표에 없는 사이즈입니다. 최대 2000mm까지 입력 가능합니다.';
  }
}

// 사용자가 input 박스를 클릭하면 기본값 지우기
document.getElementById('gomuQ').addEventListener('click', function () {
  const input = document.getElementById('gomuQ');
  if (input.value === '1') {
    input.value = '';
  }
});

document.getElementById('gomuH').addEventListener('click', function () {
  const input = document.getElementById('gomuH');
  if (input.value === '1') {
    input.value = '';
  }
});

//아크릴 엔터키로 계산하기 -M에 focus 이벤트
gomuQ.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

//아크릴 엔터키로 계산하기 -M에 focus 이벤트
gomuH.addEventListener('focus', () => {
  document.addEventListener('keydown', calculateOnEnter);
});

// 문서의 콘텐츠가 모두 로드된 이후 실행
// 데이터 채워넣기
window.onload = function () {
  drawEpoxyCalculator();
};
