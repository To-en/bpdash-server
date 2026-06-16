
import { DataTypes } from 'sequelize';
export let Stat;

export const initStatModel = (sequelize) => {
  Stat = sequelize.define('Stat', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    session_id: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    session_name: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    data: { type: DataTypes.JSONB }
  }, {
    tableName: 'stats',
    timestamps: true,
    indexes: [
      {
        fields: ['session_id']
      },
      {
        fields: ['session_name']
      }
    ]
  });
  return Stat;
};
