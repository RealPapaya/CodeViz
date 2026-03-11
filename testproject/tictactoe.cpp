#include "tictactoe.h"
#include <iostream>

TicTacToe::TicTacToe() : board(3, std::vector<char>(3, ' ')), currentPlayer('X') {}

void TicTacToe::printBoard() const {
    std::cout << "\n";
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            std::cout << " " << board[i][j] << " ";
            if (j < 2) std::cout << "|";
        }
        std::cout << "\n";
        if (i < 2) std::cout << "---|---|---\n";
    }
    std::cout << "\n";
}

bool TicTacToe::makeMove(int row, int col) {
    if (row >= 0 && row < 3 && col >= 0 && col < 3 && board[row][col] == ' ') {
        board[row][col] = currentPlayer;
        return true;
    }
    return false;
}

bool TicTacToe::checkWin() const {
    // Check rows and columns
    for (int i = 0; i < 3; ++i) {
        if ((board[i][0] != ' ' && board[i][0] == board[i][1] && board[i][1] == board[i][2]) ||
            (board[0][i] != ' ' && board[0][i] == board[1][i] && board[1][i] == board[2][i])) {
            return true;
        }
    }
    // Check diagonals
    if ((board[0][0] != ' ' && board[0][0] == board[1][1] && board[1][1] == board[2][2]) ||
        (board[0][2] != ' ' && board[0][2] == board[1][1] && board[1][1] == board[2][0])) {
        return true;
    }
    return false;
}

bool TicTacToe::checkDraw() const {
    for (const auto& row : board) {
        for (char cell : row) {
            if (cell == ' ') return false;
        }
    }
    return !checkWin();
}

void TicTacToe::switchPlayer() {
    currentPlayer = (currentPlayer == 'X') ? 'O' : 'X';
}

void TicTacToe::play() {
    int row, col;
    bool gameOver = false;

    std::cout << "Welcome to Tic-Tac-Toe!\n";

    while (!gameOver) {
        printBoard();
        std::cout << "Player " << currentPlayer << ", enter your move (row and column: 0, 1, or 2): ";
        std::cin >> row >> col;

        if (makeMove(row, col)) {
            if (checkWin()) {
                printBoard();
                std::cout << "Player " << currentPlayer << " wins!\n";
                gameOver = true;
            } else if (checkDraw()) {
                printBoard();
                std::cout << "It's a draw!\n";
                gameOver = true;
            } else {
                switchPlayer();
            }
        } else {
            std::cout << "Invalid move. Try again.\n";
        }
    }
}
