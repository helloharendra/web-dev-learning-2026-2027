let currentValue = '0'      // the number shown on the display (kept as text)
let previousValue = null    // the first number, saved when an operator is pressed
let operator = null         // the chosen operator: + - * /
let startNewNumber = false  // true means the next digit starts a new number

const displayElement = document.getElementById('display')
const expressionElement = document.getElementById('expression')

const operatorSymbols = { '+': '+', '-': '−', '*': '×', '/': '÷' }


function updateDisplay() {
    displayElement.innerText = currentValue

    if (currentValue.length > 12) {
        displayElement.classList.add('small')
    } else {
        displayElement.classList.remove('small')
    }
}

function clearAll() {
    currentValue = '0'
    previousValue = null
    operator = null
    startNewNumber = false
    expressionElement.innerText = ''
    updateDisplay()
}

function pressNumber(number) {
    if (currentValue === 'Error') {
        clearAll()
    }

    if (startNewNumber) {
        currentValue = number
        startNewNumber = false
    } else if (currentValue === '0') {
        currentValue = number
    } else if (currentValue.length < 15) {
        currentValue = currentValue + number
    }

    updateDisplay()
}

function pressDot() {
    if (currentValue === 'Error') {
        clearAll()
    }

    if (startNewNumber) {
        currentValue = '0.'
        startNewNumber = false
    } else if (!currentValue.includes('.')) {
        currentValue = currentValue + '.'
    }

    updateDisplay()
}

function deleteLast() {
    if (currentValue === 'Error') {
        clearAll()
        return
    }

    // A finished result (or a number like 1e-9) is not edited digit by digit
    if (startNewNumber || currentValue.includes('e')) {
        return
    }

    currentValue = currentValue.slice(0, -1)

    if (currentValue === '' || currentValue === '-') {
        currentValue = '0'
    }

    updateDisplay()
}

function pressPercent() {
    if (currentValue === 'Error') {
        return
    }

    currentValue = String(roundResult(Number(currentValue) / 100))
    startNewNumber = false
    updateDisplay()
}

function pressOperator(newOperator) {
    if (currentValue === 'Error') {
        return
    }

    // 5 + 3 + ... : work out 5 + 3 first, then carry on from the answer
    if (operator !== null && !startNewNumber) {
        calculate()

        if (currentValue === 'Error') {
            return
        }
    }

    previousValue = currentValue
    operator = newOperator
    startNewNumber = true
    expressionElement.innerText = previousValue + ' ' + operatorSymbols[operator]
}

function pressEquals() {
    if (operator === null || currentValue === 'Error') {
        return
    }

    expressionElement.innerText = previousValue + ' ' + operatorSymbols[operator] + ' ' + currentValue + ' ='
    calculate()
    operator = null
}

function calculate() {
    let a = Number(previousValue)
    let b = Number(currentValue)
    let result

    if (operator === '+') {
        result = a + b
    } else if (operator === '-') {
        result = a - b
    } else if (operator === '*') {
        result = a * b
    } else if (operator === '/') {
        if (b === 0) {
            showError()
            return
        }
        result = a / b
    }

    currentValue = String(roundResult(result))
    startNewNumber = true
    updateDisplay()
}

function showError() {
    currentValue = 'Error'
    previousValue = null
    operator = null
    startNewNumber = true
    expressionElement.innerText = 'Cannot divide by 0'
    updateDisplay()
}

// Fixes decimal problems, for example 0.1 + 0.2 gives 0.30000000000000004 in JS
function roundResult(number) {
    return parseFloat(number.toFixed(10))
}


// Keyboard support
document.addEventListener('keydown', function (event) {
    let key = event.key

    if (key >= '0' && key <= '9') {
        pressNumber(key)
    } else if (key === '.') {
        pressDot()
    } else if (key === '+' || key === '-' || key === '*' || key === '/') {
        event.preventDefault()
        pressOperator(key)
    } else if (key === 'Enter' || key === '=') {
        // Stops Enter from also clicking the button that was clicked last
        event.preventDefault()
        pressEquals()
    } else if (key === 'Backspace') {
        deleteLast()
    } else if (key === 'Escape') {
        clearAll()
    } else if (key === '%') {
        pressPercent()
    }
})
