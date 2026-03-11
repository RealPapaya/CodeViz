#ifndef TICTACTOE_H
#define TICTACTOE_H

#include <vector>

class TicTacToe {
public:
    TicTacToe();
    void play();

private:
    std::vector<std::vector<char>> board;
    char currentPlayer;

    void printBoard() const;
    bool makeMove(int row, int col);
    bool checkWin() const;
    bool checkDraw() const;
    void switchPlayer();
};

#endif // TICTACTOE_H
